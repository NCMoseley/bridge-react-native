import { config } from '../config.js';
import { Database } from '../database.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run create-user -- user@example.com');
  process.exit(1);
}

const user = new Database().createUser(email);
console.log(JSON.stringify({
  email: user.email,
  webhookUrl: `${config.PUBLIC_BASE_URL}/webhooks/${user.id}/${user.webhookSecret}`,
  extensionToken: user.extensionToken,
}, null, 2));
