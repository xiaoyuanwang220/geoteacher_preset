// asar-grep.mjs — print regex matches with surrounding context from a very large
// single-file text blob (the DSH asar), which the normal read/grep tools cannot page.
// usage: node asar-grep.mjs <file> <regex> [before=0] [after=0] [maxMatches=20] [maxLen=400]
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Under Electron the fs layer hijacks any path inside an `.asar`, so a path that *is*
// the archive resolves to "not found in <asar>". Turn that off for raw byte access.
process.noAsar = true;

const [file, pattern, beforeArg = '0', afterArg = '0', maxArg = '20', maxLenArg = '400'] = process.argv.slice(2);
if (!file || !pattern) {
  console.error('usage: asar-grep.mjs <file> <regex> [before] [after] [maxMatches] [maxLen]');
  process.exit(2);
}
const re = new RegExp(pattern);
const before = Number(beforeArg);
const after = Number(afterArg);
const maxMatches = Number(maxArg);
const maxLen = Number(maxLenArg);

const cut = (s) => (s.length > maxLen ? `${s.slice(0, maxLen)}…[+${s.length - maxLen}]` : s);
const ring = [];
let n = 0;
let matches = 0;
let pendingAfter = 0;

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
for await (const line of rl) {
  n += 1;
  if (pendingAfter > 0) {
    console.log(`${n}\t${cut(line)}`);
    pendingAfter -= 1;
    if (pendingAfter === 0 && matches >= maxMatches) break;
    continue;
  }
  if (re.test(line)) {
    matches += 1;
    if (matches > maxMatches) break;
    for (const [ln, text] of ring) console.log(`${ln}\t${cut(text)}`);
    console.log(`${n}\t${cut(line)}`);
    pendingAfter = after;
    if (pendingAfter === 0 && matches >= maxMatches) break;
  }
  ring.push([n, line]);
  if (ring.length > before) ring.shift();
}
console.log(`--- ${matches} match(es) at/after line ${n} ---`);
