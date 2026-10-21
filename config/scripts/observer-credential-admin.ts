// Owner-local administration only. Never prints the bearer or puts it in Orca's device registry.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ObserverCredentialStore } from '../../src/main/runtime/observer-credential-store'
import { writeSecureFile } from '../../src/shared/secure-file'
import { outsideObserverSource } from './observer-credential-path'

const repoRoot = resolve(import.meta.dirname, '../..')
const outsideSource = (path: string) => outsideObserverSource(repoRoot, path)

const [operation, rawUserDataPath, argument, worktreeId, worktreeInstanceId] = process.argv.slice(2)
if (!rawUserDataPath || !argument) {
  throw new Error(
    'Usage: observer-credential-admin.ts issue|revoke ABS_USER_DATA ABS_OUTPUT_PATH|ID [WORKTREE_ID WORKTREE_INSTANCE_ID]'
  )
}
const userDataPath = outsideSource(rawUserDataPath)
const store = new ObserverCredentialStore(userDataPath)

if (operation === 'issue') {
  const outputPath = outsideSource(argument)
  if (existsSync(outputPath)) {
    throw new Error('Refusing to overwrite existing bearer output')
  }
  const issued = store.issue(worktreeId, worktreeInstanceId)
  try {
    if (!writeSecureFile(outputPath, `${issued.token}\n`, { durable: true })) {
      throw new Error('Bearer output could not be secured')
    }
  } catch (error) {
    store.revoke(issued.id)
    throw error
  }
  process.stdout.write(`Issued observer credential ${issued.id}; bearer saved to ${outputPath}\n`)
} else if (operation === 'revoke') {
  if (!/^[0-9a-f-]{36}$/.test(argument)) {
    throw new Error('Invalid credential id')
  }
  const removed = store.revoke(argument)
  process.stdout.write(removed ? `Revoked ${argument}\n` : `Credential ${argument} not found\n`)
} else {
  throw new Error('Expected issue or revoke')
}
