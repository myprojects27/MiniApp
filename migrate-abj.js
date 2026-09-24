// migrate-abj.js — update env docs, switch git remote, push to new repo
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

process.chdir(__dirname);

const NEW_REPO = 'https://github.com/myprojects27/MiniApp.git';
const NEW_SUPABASE_URL = 'https://pkehwcbzhjvsyflcgvzu.supabase.co';
const NEW_SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBrZWh3Y2J6aGp2c3lmbGNndnp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNjg4NDUsImV4cCI6MjEwNTg0NDg0NX0.WObYDGp8vupbxKGJ9ASa_IxlWmUrk8CLtgnIx1ymc3A';

// 1. Write .env.example with the new Supabase project's public values
console.log('\n=== 1. Writing .env.example ===');
const envExample = `# Supabase (project: pkehwcbzhjvsyflcgvzu)
SUPABASE_URL=${NEW_SUPABASE_URL}
SUPABASE_SERVICE_KEY=PASTE_YOUR_SERVICE_ROLE_KEY_HERE
JWT_SECRET=PASTE_YOUR_JWT_SECRET_HERE
ADMIN_PASSWORD=Choose_a_strong_admin_password
`;
fs.writeFileSync('.env.example', envExample, 'utf8');
console.log('  wrote: .env.example');

// 2. Create .env for local vercel dev
console.log('\n=== 2. Writing local .env ===');
const envLocal = `SUPABASE_URL=${NEW_SUPABASE_URL}
SUPABASE_SERVICE_KEY=PASTE_YOUR_SERVICE_ROLE_KEY_HERE
JWT_SECRET=PASTE_YOUR_JWT_SECRET_HERE
ADMIN_PASSWORD=ChangeMe_Admin_1234
`;
if (!fs.existsSync('.env')) {
  fs.writeFileSync('.env', envLocal, 'utf8');
  console.log('  wrote: .env (edit before running vercel dev)');
} else {
  console.log('  .env already exists — leaving it alone');
}

// 3. Ensure .env is gitignored
console.log('\n=== 3. Ensuring .env is gitignored ===');
const gi = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
if (!gi.includes('.env')) {
  fs.appendFileSync('.gitignore', '\n.env\n.env.local\nnode_modules\n.vercel\n');
  console.log('  updated .gitignore');
} else {
  console.log('  .gitignore already covers .env');
}

// 4. Switch git remote
console.log('\n=== 4. Switching git remote ===');
try {
  execSync('git remote remove origin', { stdio: 'ignore' });
} catch {}
execSync(`git remote add origin ${NEW_REPO}`, { stdio: 'inherit' });
console.log('  remote set to: ' + NEW_REPO);

// 5. Rename branch + push
console.log('\n=== 5. Pushing to new repo ===');
try {
  execSync('git branch -M main', { stdio: 'inherit' });
  execSync('git add -A', { stdio: 'inherit' });
  execSync('git commit -m "Migrate to new Supabase project + new GitHub repo" --allow-empty', { stdio: 'inherit' });
  execSync('git push -u origin main --force', { stdio: 'inherit' });
  console.log('\nDONE');
} catch (e) {
  console.log('\nGit error:', e.message);
  console.log('  If auth fails, run: git remote set-url origin https://github.com/myprojects27/MiniApp.git');
  console.log('  Then push again with your GitHub token as the password.');
}