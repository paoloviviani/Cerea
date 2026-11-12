# Draws the two icons (template PNG for the menu bar, 1024px app icon).
# Usage: python3 gen-icons.py OUT_DIR  (icon.png -> agent/cmd/galopin-tray/, app-icon-1024.png -> here)
import zlib,struct,math,sys
def png(path,size,fn):
    rows=[]
    for y in range(size):
        r=b'\x00'
        for x in range(size):
            r+=bytes(fn(x,y,size))
        rows.append(r)
    raw=b''.join(rows)
    def ch(t,d): 
        c=struct.pack('>I',len(d))+t+d
        return c+struct.pack('>I',zlib.crc32(t+d)&0xffffffff)
    open(path,'wb').write(b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+ch(b'IDAT',zlib.compress(raw,9))+ch(b'IEND',b''))
def cov(x,y,s):
    # a "C": ring with an opening on the right
    cx=cy=(s-1)/2; d=math.hypot(x-cx,y-cy); R=s*0.40; w=s*0.11
    a=math.degrees(math.atan2(y-cy,x-cx))
    ring=max(0,min(1,w/2+0.5-abs(d-(R-w/2))))
    if abs(a)<38: ring=0
    return ring
def tmpl(x,y,s): return (0,0,0,int(255*cov(x,y,s)))
def app(x,y,s):
    cx=cy=(s-1)/2
    # rounded square background
    k=s*0.18; dx=max(abs(x-cx)-(s*0.42-k),0); dy=max(abs(y-cy)-(s*0.42-k),0)
    bg=max(0,min(1,k+0.5-math.hypot(dx,dy)))
    c=cov(x,y,s)
    r,g,b=(int(40+215*c),int(110+145*c),int(90+165*c))
    return (r,g,b,int(255*bg))
out=sys.argv[1]
png(out+'/icon.png',44,tmpl)
png(out+'/app-icon-1024.png',1024,app)
