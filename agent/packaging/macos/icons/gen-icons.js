// Regenerates the Cerea connector icons from the brand's pixel ridge (brand/pixel_ridge_avatar.png):
// tray template agent/cmd/galopin-tray/icon.png (solid black, every lit cell two cells thick so it
// reads at menu-bar size, cropped tight to the ridge; macOS tints a template for light and dark)
// and the 1024 px app icon agent/packaging/macos/app-icon-1024.png. Run from a dir holding
// avatar.png, with Playwright available: NODE_PATH=<repo>/node_modules node gen-icons.js
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
	const b = await chromium.launch();
	const p = await b.newPage({ deviceScaleFactor: 1 });
	const src = "data:image/png;base64," + fs.readFileSync("avatar.png").toString("base64");
	// tray template: 24x8 lit cells x4, two cells thick, cropped
	await p.setContent(`<html><body style="margin:0;background:transparent"><canvas id="c"></canvas><canvas id="v"></canvas><script>
const img=new Image();img.onload=()=>{const t=document.createElement('canvas');t.width=24;t.height=8;const tx=t.getContext('2d');tx.drawImage(img,0,0);
const d=tx.getImageData(0,0,24,8).data;const on=[];let minY=99,maxY=0;
for(let y=0;y<8;y++)for(let x=0;x<24;x++){const i=(y*24+x)*4;if(d[i+3]>40&&(d[i]+d[i+1]+d[i+2])/3<200){on.push([x,y]);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
const rows=maxY-minY+2; const cell=4; const W=24*cell, H=rows*cell; 
const c=document.getElementById('c');c.width=W;c.height=H;const cx=c.getContext('2d');cx.fillStyle='#000';
for(const [x,y] of on){cx.fillRect(x*cell,(y-minY)*cell,cell,cell*2);} // two cells thick, solid
// preview: menu bar sized (scaled to 18px tall) on grey, light and dark
const v=document.getElementById('v');v.width=260;v.height=60;const vx=v.getContext('2d');vx.fillStyle='#d9d9d9';vx.fillRect(0,0,130,60);vx.fillStyle='#2b2b2b';vx.fillRect(130,0,130,60);
const h=18,w=Math.round(W*h/H);vx.imageSmoothingEnabled=true;vx.drawImage(c,20,21,w,h);
const inv=document.createElement('canvas');inv.width=W;inv.height=H;const ix=inv.getContext('2d');ix.drawImage(c,0,0);ix.globalCompositeOperation='source-in';ix.fillStyle='#fff';ix.fillRect(0,0,W,H);vx.drawImage(inv,150,21,w,h);
document.title='done '+W+'x'+H;};img.src='${src}';</script></body></html>`);
	await p.waitForFunction(() => document.title.startsWith("done"));
	console.log(await p.title());
	await (await p.$("#c")).screenshot({ path: "tray.png", omitBackground: true });
	// app icon: tile with the avatar at x28 (672x224), nearest-neighbour
	await p.setContent(
		`<html><body style="margin:0;background:transparent"><div id="a" style="width:1024px;height:1024px;display:flex;align-items:center;justify-content:center"><div style="width:824px;height:824px;border-radius:185px;background:linear-gradient(160deg,#ffffff,#eef2f6);box-shadow:inset 0 0 0 2px #d8dee6;display:flex;align-items:center;justify-content:center"><img src="${src}" style="width:672px;height:224px;image-rendering:pixelated"></div></div></body></html>`
	);
	await (await p.$("#a")).screenshot({ path: "app-icon-1024.png", omitBackground: true });
	await b.close();
})();
