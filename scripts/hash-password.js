const bcrypt = require("bcryptjs");

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error("Usage: node scripts/hash-password.js yourPasswordHere");
    process.exit(1);
  }

  const saltRounds = 10;
  const hash = await bcrypt.hash(password, saltRounds);

  console.log("Password:", password);
  console.log("Hash:", hash);
}

main().catch(error => {
  console.error("Failed to hash password:", error);
  process.exit(1);
});