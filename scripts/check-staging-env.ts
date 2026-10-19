import fs from 'fs';

if (fs.existsSync('.env.staging.pulled')) {
  const content = fs.readFileSync('.env.staging.pulled', 'utf8');
  for (const line of content.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) {
      const val = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');
      console.log('Starts with postgres:', val.startsWith('postgres'));
      const atIdx = val.lastIndexOf('@');
      if (atIdx !== -1) {
        console.log('Host/db part:', val.slice(atIdx + 1));
      } else {
        console.log('Val prefix:', val.slice(0, 15));
      }
    }
  }
}
