// Regenerates the Cerea connector icons from the brand's pixel ridge (brand/pixel_ridge_avatar.png):
// tray template agent/cmd/galopin-tray/icon.png (black, alpha from the pixel shade) and the
// 1024 px app icon agent/packaging/macos/app-icon-1024.png. Run from a dir holding avatar.png,
// with Playwright available: NODE_PATH=<repo>/node_modules node gen-icons.js
const { chromium } = require('playwright'); const fs=require('fs');
(async()=>{const b=await chromium.launch();const p=await b.newPage({deviceScaleFactor:1});
const src='data:image/png;base64,'+fs.readFileSync('avatar.png').toString('base64');
// tray template: alpha from darkness, 24x8 -> x5 = 120x40, padded to 120x44
await p.setContent(`<html><body style="margin:0;background:transparent"><canvas id="c" width="120" height="44"></canvas><script>
const img=new Image();img.onload=()=>{const t=document.createElement('canvas');t.width=24;t.height=8;const tx=t.getContext('2d');tx.drawImage(img,0,0);
const d=tx.getImageData(0,0,24,8).data;const c=document.getElementById('c').getContext('2d');
for(let y=0;y<8;y++)for(let x=0;x<24;x++){const i=(y*24+x)*4;const a=d[i+3]/255;const lum=(d[i]+d[i+1]+d[i+2])/765;const alpha=a*(1-lum*0.75);
if(alpha<=0.02)continue;c.fillStyle='rgba(0,0,0,'+alpha.toFixed(3)+')';c.fillRect(x*5,y*5+2,5,5);}document.title='done';};img.src='${src}';</script></body></html>`);
await p.waitForFunction(()=>document.title==='done');
await (await p.$('#c')).screenshot({path:'tray.png',omitBackground:true});
// app icon: tile with the avatar at x28 (672x224), nearest-neighbour
await p.setContent(`<html><body style="margin:0;background:transparent"><div id="a" style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center"><div style="width:824px;height:824px;border-radius:185px;background:linear-gradient(160deg,#ffffff,#eef2f6);box-shadow:inset 0 0 0 2px #d8dee6;display:flex;align-items:center;justify-content:center"><img src="${src}" style="width:672px;height:224px;image-rendering:pixelated"></div></div></body></html>`);
await (await p.$('#a')).screenshot({path:'app-icon-1024.png',omitBackground:true});
await b.close();})();
