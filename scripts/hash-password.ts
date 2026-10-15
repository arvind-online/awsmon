import { hashPassword } from '../server/src/auth.js';

const pw = process.argv[2];
if (!pw || pw.length < 12) {
  console.error('Usage: npm run hash-password -- "<password of at least 12 characters>"');
  process.exit(1);
}
console.log(await hashPassword(pw));
