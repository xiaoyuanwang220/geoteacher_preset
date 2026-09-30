// probe-plugins.mjs — can the geo preset's local plugin modules be imported as ESM
// when resolved against the bundle directory (file:///E:/geo_edu_agent/.agent-presets/geo-teacher/)?
process.noAsar = true;

const bundle = 'file:///E:/geo_edu_agent/.agent-presets/geo-teacher/';
const profile = 'file:///C:/Users/xxx/.dsh/profiles/desktop/';

for (const [label, base] of [['bundle-dir', bundle], ['profile-dir', profile]]) {
  console.log(`--- base = ${base}`);
  for (const p of ['core', 'taxonomy', 'bank', 'analysis', 'generator', 'ui']) {
    const url = new URL(`./plugins/${p}/index.js`, base).href;
    try {
      const mod = await import(url);
      console.log(`  OK   ${p}  default=${typeof mod.default}  exports=${Object.keys(mod).join(',') || '(default only)'}`);
    } catch (error) {
      console.log(`  FAIL ${p}  ${error.code ?? ''} ${error.message.split('\n')[0]}`);
    }
  }
  try {
    const skillsUrl = new URL('./skills/', base).href;
    const { statSync, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(skillsUrl);
    console.log(`  skills: ${dir} -> ${statSync(dir).isDirectory() ? readdirSync(dir).join(', ') : 'not a dir'}`);
  } catch (error) {
    console.log(`  skills: FAIL ${error.code ?? ''} ${error.message.split('\n')[0]}`);
  }
}
