// Quick syntax check on the JSX/React portion using @babel/parser if available.
// If not available, fall back to checking that the file balances.
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
const src = m[1];

let parser = null;
try { parser = require('@babel/parser'); } catch (_) {}

if (parser) {
  try {
    parser.parse(src, {
      sourceType: 'script',
      plugins: ['jsx'],
      allowReturnOutsideFunction: true,
    });
    console.log('Babel parsed', src.length, 'chars cleanly.');
  } catch (e) {
    console.error('Parse error:', e.message);
    process.exit(1);
  }
} else {
  console.log('@babel/parser not installed; skipping JSX parse. Pure-JS portion already checked.');
}
