// probe2.mjs — resolve the geo preset's new module specifiers exactly the way the
// preset registry does: from the declaring context's baseUrl (the profile directory).
process.noAsar = true;
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';

const base = 'file:///C:/Users/xxx/.dsh/profiles/desktop/'; // record.context.baseUrl
const require_ = createRequire(base);

for (const p of ['core', 'taxonomy', 'bank', 'analysis', 'generator', 'ui']) {
  const spec = `@geo-edu/dsh-geo-teacher-preset/plugins/${p}`;
  try {
    const resolved = require_.resolve(spec);
    const mod = await import(resolved);
    console.log(`OK   ${spec}  ->  ${resolved}  default=${typeof mod.default}`);
  } catch (error) {
    console.log(`FAIL ${spec}  ${error.code ?? ''} ${String(error.message).split('\n')[0]}`);
  }
}

// The `!!js` skills expression, verbatim from the patch.
try {
  const p = process.getBuiltinModule('node:path');
  const skills = p.join(
    p.dirname(process.getBuiltinModule('node:module').createRequire(base).resolve('@geo-edu/dsh-geo-teacher-preset/package.json')),
    'skills',
  );
  console.log(`SKILLS ${skills} -> ${statSync(skills).isDirectory() ? 'OK' : 'not a directory'}`);
} catch (error) {
  console.log(`SKILLS FAIL ${error.code ?? ''} ${String(error.message).split('\n')[0]}`);
}
