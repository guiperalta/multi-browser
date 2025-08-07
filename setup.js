const fs = require('fs');
const path = require('path');

console.log('🚀 Setting up Multi Browser Manager...\n');

// Create assets directory
const assetsDir = path.join(__dirname, 'assets');
if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
    console.log('✅ Created assets directory');
}

// Create browser-sessions directory
const sessionsDir = path.join(__dirname, 'browser-sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    console.log('✅ Created browser-sessions directory');
}

// Create a simple icon placeholder (you can replace this with a real icon)
const iconPath = path.join(assetsDir, 'icon.png');
if (!fs.existsSync(iconPath)) {
    // Create a simple text file as placeholder
    fs.writeFileSync(path.join(assetsDir, 'icon-info.txt'), 
        'Add your app icon here as icon.png (256x256 recommended)\n' +
        'For now, the app will use the default Electron icon.');
    console.log('✅ Created icon placeholder info');
}

console.log('\n🎉 Setup complete!');
console.log('\nNext steps:');
console.log('1. Run: npm install');
console.log('2. Run: npm start');
console.log('\nMake sure Google Chrome is installed on your system.');
