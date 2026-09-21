const fs = require("node:fs/promises");
const path = require("node:path");

exports.createVault = function createVault(userData, safeStorage) {
  async function accessVault(method, value) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text")
    ) {
      throw new Error("系统密钥存储不可用，无法安全保存 API Key。");
    }
    const file = path.join(userData, "credentials.bin");
    if (method === "read") {
      try {
        return JSON.parse(safeStorage.decryptString(await fs.readFile(file)));
      } catch (error) {
        if (error.code === "ENOENT") return { llmApiKey: "", cloudToken: "", codexApiKey: "" };
        throw error;
      }
    }
    if (
      method !== "write" ||
      typeof value?.llmApiKey !== "string" ||
      typeof value?.cloudToken !== "string"
    )
      throw new Error("Invalid secret request");
    const next = { llmApiKey: value.llmApiKey, cloudToken: value.cloudToken, codexApiKey: typeof value.codexApiKey === "string" ? value.codexApiKey : "" };
    await fs.writeFile(
      file + ".tmp",
      safeStorage.encryptString(JSON.stringify(next)),
      { mode: 0o600 },
    );
    await fs.rename(file + ".tmp", file);
    return next;
  }

  let queue = Promise.resolve();
  return (method, value) => {
    const result = queue.then(() => accessVault(method, value));
    queue = result.catch(() => {});
    return result;
  };
};
