const release = Object.freeze({
  version: "8.30.1",
  platforms: {
    "win32-x64": {
      archive: "gitleaks_8.30.1_windows_x64.zip",
      executable: "gitleaks.exe",
      archiveSha256: "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
      binarySha256: "17157e2ee8b76fc8b1d8bee607a250e34b8a8023c8bc81822d4b5ee4d78fcb7c",
    },
    "linux-x64": {
      archive: "gitleaks_8.30.1_linux_x64.tar.gz",
      executable: "gitleaks",
      archiveSha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
      binarySha256: "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
    },
  },
});
module.exports = { release };
