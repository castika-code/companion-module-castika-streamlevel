// What Companion actually imports.
//
// It reads the class and the upgrade scripts off the module rather than off the
// class, and the module it reads is the ES bundle the build produces. A bundle
// made from a CommonJS entry carries a default export and nothing else, so named
// exports would not survive. This file is ES; the module behind it stays
// CommonJS.
import StreamLevelInstance from './main.js'

export default StreamLevelInstance
export const UpgradeScripts = StreamLevelInstance.UpgradeScripts
