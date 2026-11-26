import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const packageRoot = HERE;
export const vaultDir = join(HERE, 'obsidian_vault');
export const questionBankDir = join(vaultDir, '04_题目');
export const attachmentsDir = join(vaultDir, '90_附件');

export function resolveDataPaths() {
  return {
    packageRoot,
    vaultDir,
    questionBankDir,
    attachmentsDir,
  };
}

export default {
  packageRoot,
  vaultDir,
  questionBankDir,
  attachmentsDir,
  resolveDataPaths,
};
