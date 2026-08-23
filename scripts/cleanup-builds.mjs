import fs from "node:fs";
import path from "node:path";

const root=path.resolve(new URL("..",import.meta.url).pathname);
for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^dist(?:-|$)/.test(entry.name)||entry.name==="dist")continue;
  fs.rmSync(path.join(root,entry.name),{recursive:true,force:true});
}
const dist=path.join(root,"dist");
if(fs.existsSync(dist))for(const entry of fs.readdirSync(dist)){
  if(/^app\.asar\.onceki(?:-|$)/.test(entry))fs.rmSync(path.join(dist,entry),{recursive:true,force:true});
}
console.log("Eski masaüstü derlemeleri ve geçici paket yedekleri temizlendi.");
