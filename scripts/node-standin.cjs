// A stand-in node that reads a command text EXACTLY as the real one does (CommandRunner.runMultiCommand:
// `new StringTokenizer(zCommand, ";")`, each piece Java-trim()med and run as its own command — quotes and JSON are
// NOT respected), so an injected second command cannot hide behind a mock that treats the text as one command.
// Every piece is run (as when each succeeds; a truncated runscript still answers status:true) and recorded in `ran`.
function pieces(text) { return String(text).split(';').map(s => s.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '')).filter(Boolean); }
function verb(piece) { return piece.split(/[\s:]/)[0].replace(/"/g, '').toLowerCase(); }
function standin(reply) {
  const ran = [], texts = [];
  return {
    ran, texts,
    sends: () => ran.filter(p => verb(p) === 'send'),
    cmd(q, cb) { texts.push(q); const out = pieces(q).map(p => { ran.push(p); return reply(p, verb(p)); }); if (cb) cb(out[0] || { status: false }); }
  };
}
module.exports = { pieces, verb, standin };
