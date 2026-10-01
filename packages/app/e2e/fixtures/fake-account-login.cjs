const fs = require("node:fs");
const path = require("node:path");
const credential = path.join(process.env.CLAUDE_CONFIG_DIR, "signed-in");
const args = new Set(process.argv.slice(2));
if (args.has("status")) {
  const loggedIn = fs.existsSync(credential);
  console.log(JSON.stringify({ loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}
if (args.has("login")) {
  console.log("https://claude.com/cai/oauth/authorize?state=browser-fixture");
  process.stdin.once("data", (input) => {
    if (input.toString().trim() !== "browser-test-code") process.exit(1);
    fs.writeFileSync(credential, "signed-in");
    process.exit(0);
  });
} else {
  process.exit(1);
}
