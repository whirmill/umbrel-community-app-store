import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { Store } from "../store.js";

// Real application, TCP body iteration and OS signals. Only fixture observation
// wraps IncomingMessage's original iterator; it does not change dispatch/exit.
const fixture = `
import {IncomingMessage, Server} from 'node:http';
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once('listening',()=>process.send({event:'listening',port:this.address().port}));
  return listen.apply(this,args);
};
const iterate = IncomingMessage.prototype[Symbol.asyncIterator];
IncomingMessage.prototype[Symbol.asyncIterator] = async function* () {
  for await (const chunk of iterate.call(this)) {
    yield chunk;
    if (this.url === process.env.GATED_PATH) process.send({event:'body-read'});
  }
};
import {startApplication} from './dist/server-app.js';
await startApplication();
for (const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>process.send({event:'signal-received'}));
`;

function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture deadline")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

for (const [path, signal] of [["/api/owner/login", "SIGINT"], ["/api/pause", "SIGTERM"]] as const) {
  test(`${signal}: body admitted before shutdown cannot ${path === "/api/pause" ? "pause state" : "issue an owner session"} afterward`, {timeout: 15000}, async () => {
    const directory = mkdtempSync(join(tmpdir(), "surge-shutdown-http-"));
    const initial = new Store(join(directory, "operational.sqlite"));
    initial.set("enabled", true);
    initial.set("maintenanceClaim", {owner: "fixture-maintenance"});
    initial.close();
    writeFileSync(join(directory, "owner.secret"), "fixture-owner", {mode: 0o600});
    const child = spawn(process.execPath, ["--input-type=module", "-e", fixture], {
      env: {...process.env, DATA_DIR: directory, HISTORY_DIR: join(directory, "absent"), PORT: "0", GATED_PATH: path},
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    // No credentials/provider/financial runtime: the normal missing-provisioning
    // path still supplies the actual app, store, auth and lifecycle handlers.
    child.stdout!.resume(); child.stderr!.resume();
    const exit = new Promise<[number|null, NodeJS.Signals|null]>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, why) => resolve([code, why]));
    });
    void exit.catch(() => {});
    let pending: ReturnType<typeof request> | undefined;
    const observers = new Map<string, () => void>();
    child.on("message", (value: any) => observers.get(value?.event)?.());
    const observe = (event: string) => new Promise<void>(resolve => observers.set(event, resolve));
    try {
      // Observe the real listening port without reserving/releasing a racy port.
      // The fixture wraps listen only to report its bound address over private IPC.
      const listening = observe("listening");
      let port = 0;
      child.on("message", (value: any) => { if (value?.event === "listening") port = value.port; });
      await bounded(listening);
      const base = `http://127.0.0.1:${port}`;
      const login = await fetch(base + "/api/owner/login", {method: "POST", headers: {Origin: base}, body: JSON.stringify({password: "fixture-owner"}), signal: AbortSignal.timeout(5000)});
      assert.equal(login.status, 200);
      const {session} = await login.json() as any;
      const headers = {Authorization: `Bearer ${session}`};
      const stateResponse = await fetch(base + "/api/status", {headers, signal: AbortSignal.timeout(5000)});
      assert.equal(stateResponse.status, 200);
      const state = await stateResponse.json() as any;
      const bodyRead = observe("body-read"), signalled = observe("signal-received");
      const response = new Promise<{status: number|undefined, body: any}>((resolve, reject) => {
        pending = request(base + path, {method: "POST", headers: {...headers, Origin: base, "x-csrf-token": state.csrf, "Content-Type": "application/json"}}, res => {
          let raw = "";
          res.setEncoding("utf8"); res.on("data", chunk => { raw += chunk; });
          res.once("error", reject);
          res.once("end", () => { try { resolve({status: res.statusCode, body: JSON.parse(raw)}); } catch (error) { reject(error); } });
        });
        pending.once("error", reject);
        pending.write('{"password":');
      });
      void response.catch(() => {});
      await bounded(bodyRead);
      assert.equal(child.kill(signal), true);
      await bounded(signalled);
      // HTTP is deliberately incomplete until the real shutdown handler has run.
      pending!.end('"fixture-owner"}');
      const result = await bounded(response);
      assert.equal(result.status, 503);
      assert.match(result.body.error, /shutting down/);
      assert.equal(result.body.session, undefined);
      assert.deepEqual(await bounded(exit), [0, null]);
      const reopened = new Store(join(directory, "operational.sqlite"));
      try {
        assert.equal(reopened.get("enabled"), true);
        assert.deepEqual(reopened.get("maintenanceClaim"), {owner: "fixture-maintenance"});
        assert.equal(reopened.get<any>("shutdown")?.state, "drained");
        assert.equal(reopened.get<any>("shutdown")?.httpDrained, true);
      } finally { reopened.close(); }
    } finally {
      pending?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(exit);
      child.stdout!.destroy(); child.stderr!.destroy(); if (child.connected) child.disconnect();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}
