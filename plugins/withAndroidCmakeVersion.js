// Pins the CMake version used for all native (C++) builds: the app and every
// library module. The SDK's default CMake 3.22.1 ships ninja 1.10, which fails on
// Windows with "Filename longer than 260 characters" / mkdir errors even when long
// paths are enabled. Newer CMake releases bundle a long-path-aware ninja.
const { withAppBuildGradle, withProjectBuildGradle } = require('expo/config-plugins');

const MARKER = '// @tab/cmake-version';

function upsert(contents, block, insert) {
  const existing = new RegExp(`${MARKER}\\n[\\s\\S]*?// end ${MARKER.slice(3)}\\n`);
  if (existing.test(contents)) return contents.replace(existing, block);
  return insert(contents);
}

module.exports = function withAndroidCmakeVersion(config, { version = '3.31.6' } = {}) {
  config = withAppBuildGradle(config, (cfg) => {
    const block =
      `${MARKER}\n    externalNativeBuild {\n        cmake {\n            version "${version}"\n        }\n    }\n` +
      `    // end ${MARKER.slice(3)}\n`;
    cfg.modResults.contents = upsert(cfg.modResults.contents, block, (c) =>
      c.replace(/^android \{\n/m, (m) => `${m}    ${block}`),
    );
    return cfg;
  });

  return withProjectBuildGradle(config, (cfg) => {
    const block =
      `${MARKER}\nsubprojects {\n    plugins.withId('com.android.library') {\n` +
      `        android.externalNativeBuild.cmake.version = "${version}"\n    }\n}\n` +
      `// end ${MARKER.slice(3)}\n`;
    cfg.modResults.contents = upsert(cfg.modResults.contents, block, (c) => `${c.trimEnd()}\n\n${block}`);
    return cfg;
  });
};
