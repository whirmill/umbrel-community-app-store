import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { modelOptions, modelCapacity } from "../ui-model-picker.js";
test("official selector receives only authenticated catalog and advertised reasoning levels", () => {
 const auth = { selected:"sol", thinkingLevel:"high", models:Array.from({length:44},(_,i)=>({id:i ? `model${i}`:"sol", name:`Model ${i}`, provider:"openai", thinkingLevels:i ? ["low"]:["low","medium","high","xhigh","max"], contextWindow:272000})) };
 const options=modelOptions(auth);
 assert.equal(options.length,44);assert.deepEqual(options[0]!.efforts.map(e=>e.id),auth.models[0]!.thinkingLevels);
 assert.deepEqual(options[1]!.efforts,[{id:"low",name:"Low"}]);assert.equal(modelCapacity(auth),272000);
 assert.ok(modelOptions(auth,true).every(m=>m.disabled)); assert.deepEqual(modelOptions(null),[]);assert.equal(modelCapacity(null),undefined);
 assert.equal(modelCapacity({...auth,models:[{id:"sol",name:"Sol",contextWindow:-1}]}),undefined);
});
test("actual official vendor snapshot, local logo and MIT attribution are present without fake usage",()=>{
 // Compiled test runs under dist/test; repository source is explicitly located from cwd.
 const path="web/components/vendor/assistant-ui/";
 const provenance=JSON.parse(readFileSync(path+"provenance.json","utf8"));
 assert.equal(provenance.commit,"4ec2945e53f67f01b35dc0395df1f91c0b9f5cf4");assert.match(readFileSync(path+"LICENSE","utf8"),/MIT License/);
 for (const file of provenance.files) {
   let original = readFileSync(file.source.endsWith("openai.svg") ? "web/assets/openai.svg" : path+file.file,"utf8");
   original = original.replaceAll('"../cn"','"@/lib/utils"');
   if(file.file.startsWith("elements/")) original=original.replaceAll('"../ui/popover"','"@/components/ui/popover"').replaceAll('"../ui/command"','"@/components/ui/command"');
   else original=original.replaceAll('"./dialog"','"@/components/ui/radix/dialog"').replaceAll('"./button"','"@/components/ui/radix/button"');
   if(file.file === "ui/popover.tsx") original=original.replace('<PopoverPrimitive.Portal><div className="aui-vendor">','<PopoverPrimitive.Portal>').replace('</div></PopoverPrimitive.Portal>','</PopoverPrimitive.Portal>');
   assert.equal(createHash("sha256").update(original).digest("hex"),file.sha256,file.source);
 }

 assert.match(readFileSync("web/components/ModelPicker.tsx","utf8"),/ModelSelector\.Content/);
 assert.match(readFileSync("web/assets/openai.svg","utf8"),/<svg/);
 assert.doesNotMatch(readFileSync("src/ui-model-picker.ts","utf8"),/◈|useState|createElement/);
});
