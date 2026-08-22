import test from "node:test";
import assert from "node:assert/strict";
import { canAuthorCode, enforceTaskAssignments, requiresCodeAuthoring } from "../src/taskPolicy.js";

const members=[
  {id:"claude",provider:"claude",role:"mimar"},
  {id:"codex",provider:"codex",role:"uygulayici"},
  {id:"ag",provider:"antigravity",role:"arastirmaci"},
];

test("yalnız Claude ve Codex kod yazarıdır",()=>{
  assert.equal(canAuthorCode(members[0]),true);
  assert.equal(canAuthorCode(members[1]),true);
  assert.equal(canAuthorCode(members[2]),false);
});

test("araştırma ve görsel görevi kod modunda bile Antigravity'de kalabilir",()=>{
  const tasks=enforceTaskAssignments([{id:"t1",title:"Rakip araştırması",prompt:"Web kaynaklarını araştır ve görsel örnekleri bul",member_id:"ag"}],members,"code");
  assert.equal(tasks[0].member_id,"ag");
});

test("Antigravity'ye verilen kod görevi Claude veya Codex'e taşınır",()=>{
  const task={id:"t1",title:"API hatasını düzelt",prompt:"Node endpoint kodunu değiştir ve test yaz",member_id:"ag"};
  assert.equal(requiresCodeAuthoring(task,"code"),true);
  const [assigned]=enforceTaskAssignments([task],members,"code");
  assert.ok(["claude","codex"].includes(assigned.member_id));
  assert.notEqual(assigned.member_id,"ag");
});
