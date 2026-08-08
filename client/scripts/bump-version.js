import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const args = process.argv.slice(2);
const createGitTag = args.includes('--git') || args.includes('-g') || args.includes('--tag');
const version = args.find(arg => /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(arg));

if (!version) {
  console.error('❌ Please specify a version. Example: npm run release 0.4.4 (or node scripts/bump-version.js 0.4.4)');
  process.exit(1);
}

try {
  // 1. Update package.json
  const pkgPath = join(projectRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const oldPkgVersion = pkg.version;
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`✅ package.json: ${oldPkgVersion} ➡️ ${version}`);

  // 2. Update tauri.conf.json
  const tauriConfPath = join(projectRoot, 'src-tauri', 'tauri.conf.json');
  const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
  const oldTauriVersion = tauriConf.version;
  tauriConf.version = version;
  writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 4) + '\n', 'utf8');
  console.log(`✅ tauri.conf.json: ${oldTauriVersion} ➡️ ${version}`);

  // 3. Update Cargo.toml
  const cargoPath = join(projectRoot, 'src-tauri', 'Cargo.toml');
  let cargoContent = readFileSync(cargoPath, 'utf8');
  
  // Match version line inside Cargo.toml
  const versionRegex = /^version\s*=\s*"[^"]*"/m;
  if (!versionRegex.test(cargoContent)) {
    throw new Error('Could not find version field in Cargo.toml');
  }
  
  const match = cargoContent.match(versionRegex)[0];
  const oldCargoVersion = match.split('"')[1];
  
  cargoContent = cargoContent.replace(versionRegex, `version = "${version}"`);
  writeFileSync(cargoPath, cargoContent, 'utf8');
  console.log(`✅ src-tauri/Cargo.toml: ${oldCargoVersion} ➡️ ${version}`);

  console.log(`\n🎉 Success! Bumped all files to version ${version}.`);

  if (createGitTag) {
    const appRoot = join(projectRoot, '..');
    console.log('\n📦 Creating git commit and tag...');
    execSync(`git add "${join(projectRoot, 'package.json')}" "${join(projectRoot, 'src-tauri', 'tauri.conf.json')}" "${join(projectRoot, 'src-tauri', 'Cargo.toml')}"`, { cwd: appRoot, stdio: 'inherit' });
    execSync(`git commit -m "bump: release v${version}"`, { cwd: appRoot, stdio: 'inherit' });
    execSync(`git tag v${version}`, { cwd: appRoot, stdio: 'inherit' });
    console.log(`\n🎉 Committed version bump and created tag v${version}!`);
    console.log(`\n🚀 Next step: Run the following command to push and trigger GitHub Actions:\n   git push origin main --tags\n`);
  }
} catch (error) {
  console.error('❌ Error updating versions:', error.message);
  process.exit(1);
}
