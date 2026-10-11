import {requireLifecycleGate} from "./lifecycle-gate.js";
requireLifecycleGate("runtime");
const {startApplication}=await import("./server-app.js");
await startApplication();
