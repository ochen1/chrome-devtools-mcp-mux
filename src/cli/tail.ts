import fs from 'node:fs';
import {LOG_PATH} from '../paths.js';

export async function runTail(args: string[]): Promise<void> {
  const follow = args.includes('-f') || args.includes('--follow');
  if (!fs.existsSync(LOG_PATH)) {
    console.error(`log not found: ${LOG_PATH}`);
    process.exit(1);
  }
  const stat = fs.statSync(LOG_PATH);
  let pos = Math.max(0, stat.size - 64 * 1024);
  const fd = fs.openSync(LOG_PATH, 'r');
  const read = () => {
    const st = fs.fstatSync(fd);
    if (st.size < pos) pos = 0; // rotation
    if (st.size > pos) {
      const buf = Buffer.alloc(st.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      process.stdout.write(buf);
      pos = st.size;
    }
  };
  read();
  if (!follow) {
    fs.closeSync(fd);
    return;
  }
  setInterval(read, 250);
}
