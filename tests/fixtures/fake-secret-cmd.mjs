#!/usr/bin/env node
// Stand-in for a password manager CLI, used by test-custom-plugin.mjs.
//   list <url>                      → JSON account list
//   get <url> <field> --account <a> → the value; the account picks the behavior
const [cmd, url, field, , account] = process.argv.slice(2);

if (cmd === "list") {
  process.stdout.write(JSON.stringify([{ id: "a1", site: new URL(url).hostname, username: "tester" }]) + "\n");
  process.exit(0);
}
if (cmd !== "get") process.exit(3);

switch (account) {
  case "missing": process.stderr.write("no account\n"); process.exit(1);
  case "many": process.stderr.write("id\tusername\na1\tx\na2\ty\n"); process.exit(2);
  case "locked": process.exit(4);
  case "odd": process.stderr.write("strange failure\n"); process.exit(7);
  case "empty": process.exit(0);
  case "sleepy": await new Promise((r) => setTimeout(r, 1500)); break;
}
if (field === "echo_url") {
  process.stdout.write(url);
} else {
  // A note on stderr with exit 0 must not count as a failure.
  process.stderr.write("note: fixed something\n");
  process.stdout.write(`${field}:S3cr3t-Value!\n`);
}
