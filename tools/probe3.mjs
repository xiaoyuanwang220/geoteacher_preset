// probe3.mjs — faithful ESM resolution of the new module specifiers from the
// profile directory (the declaring context's baseUrl), plus a CJS cross-check.
process.noAsar = true;

const base = 'file:///C:/Users/xxx/.dsh/profiles/desktop/';

for (const p of ['core', 'taxonomy', 'bank', 'analysis', 'generator', 'ui']) {
  const spec = `@geo-edu/dsh-geo-teacher-preset/plugins/${p}`;
  try {
    const url = import.meta.resolve(spec, base); // ESM resolution as from the profile dir
    const mod = await import(url);
    console.log(`OK   ${spec}\n       -> ${url}\n       default=${typeof mod.default}`);
  } catch (error) {
    console.log(`FAIL ${spec}  ${error.code ?? ''} ${String(error.message).split('\n')[0]}`);
  }
}

// Negative control: the old relative specifier really does break from this base.
try {
  await import(new URL('./plugins/core/index.js', base).href);
  console.log('UNEXPECTED: relative specifier resolved');
} catch (error) {
  console.log(`control: relative './plugins/core/index.js' -> ${error.code} (expected)`);
}
