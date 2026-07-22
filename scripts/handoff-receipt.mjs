const PROVIDERS = new Set(['higgsfield', 'midjourney'])
const HIGGSFIELD_ASSET_KINDS = new Set(['image', 'video', 'product-shot', 'market-card'])
const DISPOSITIONS = new Set(['PASS', 'REPAIR', 'REJECT'])

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function blocked(missing) {
  return { ok: false, state: 'DELIVERY_BLOCKED', missing }
}

/**
 * Validate the provider-independent receipt required before a visual result may
 * leave Renderline. This validator is deliberately pure so every Hermes model
 * and transport uses the same fail-closed contract.
 */
export function verifyHandoffReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return blocked(['receipt'])

  const missing = []
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
  if (!exactKeys(receipt, ['schemaVersion', 'provider', 'assetKind', 'link', 'capture', 'qc', 'select'])) return blocked(['receipt'])

  if (receipt.schemaVersion !== 1) missing.push('schemaVersion')
  if (!PROVIDERS.has(receipt.provider)) missing.push('provider')
  if (!nonEmpty(receipt.assetKind)) missing.push('assetKind')
  if (receipt.provider === 'higgsfield' && !HIGGSFIELD_ASSET_KINDS.has(receipt.assetKind)) missing.push('assetKind')
  if (receipt.provider === 'midjourney' && receipt.assetKind !== 'grid') missing.push('assetKind')

  if (!exactKeys(receipt.link, ['contextId', 'targetId']) || !nonEmpty(receipt.link.contextId) || !nonEmpty(receipt.link.targetId)) missing.push('link')
  if (!exactKeys(receipt.capture, ['path', 'targetId']) || !nonEmpty(receipt.capture.path) || !nonEmpty(receipt.capture.targetId) ||
      receipt.capture.targetId !== receipt.link?.targetId) missing.push('capture')

  const candidates = receipt.qc?.candidates
  if (!exactKeys(receipt.qc, ['candidates']) || !Array.isArray(candidates) || candidates.length < 1 || candidates.length > 4) {
    missing.push('qc')
  } else {
    const ids = new Set()
    for (const candidate of candidates) {
      if (!exactKeys(candidate, ['id', 'score', 'disposition']) || !nonEmpty(candidate.id) || ids.has(candidate.id) ||
          !Number.isInteger(candidate.score) || candidate.score < 0 || candidate.score > 100 || !DISPOSITIONS.has(candidate.disposition)) {
        missing.push('qc')
        break
      }
      ids.add(candidate.id)
    }
  }

  const selected = receipt.select?.candidateId
  if (!exactKeys(receipt.select, ['candidateId']) || !nonEmpty(selected) || !Array.isArray(candidates) ||
      !candidates.some(candidate => candidate?.id === selected && candidate.disposition === 'PASS')) missing.push('select')

  const uniqueMissing = [...new Set(missing)]
  return uniqueMissing.length
    ? blocked(uniqueMissing)
    : { ok: true, state: 'DELIVERABLE', selectedCandidate: selected }
}
