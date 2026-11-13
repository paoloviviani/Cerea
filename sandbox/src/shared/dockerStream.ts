/** Docker's multiplexed (non-TTY) stream: 8-byte header [type,0,0,0,size BE32] + payload. */
export class Demuxer {
	private buf: Buffer = Buffer.alloc(0);
	readonly stdout: Buffer[] = [];
	readonly stderr: Buffer[] = [];
	stdoutBytes = 0;
	stderrBytes = 0;

	push(chunk: Buffer): void {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		while (this.buf.length >= 8) {
			const size = this.buf.readUInt32BE(4);
			if (this.buf.length < 8 + size) return;
			const type = this.buf[0];
			const payload = this.buf.subarray(8, 8 + size);
			if (type === 1) {
				this.stdout.push(payload);
				this.stdoutBytes += size;
			} else if (type === 2) {
				this.stderr.push(payload);
				this.stderrBytes += size;
			}
			this.buf = this.buf.subarray(8 + size);
		}
	}

	get total(): number {
		return this.stdoutBytes + this.stderrBytes;
	}
}

/** Frames a payload the way Docker does; used by tests. */
export function frame(type: 1 | 2, payload: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head[0] = type;
	head.writeUInt32BE(payload.length, 4);
	return Buffer.concat([head, payload]);
}
