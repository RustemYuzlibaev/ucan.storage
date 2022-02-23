import * as ucan from 'ucan-storage'
import { isCapabilityEscalation } from 'ucans'

/**
 * @template A
 * @param {import('ucans').CapabilitySemantics<A>} semantics
 * @param {UcanChain} ucan
 */
function* findValidCaps(semantics, ucan) {
  const caps = ucan.capabilities()
  const parentCaps = []

  for (const cap of caps) {
    if (cap.with.startsWith('prf:')) {
      const proofs = ucan.proofs()
      const [, index] = cap.with.split(':')
      const parsedIndex = Number.parseInt(index)
      if (index === '*') {
        for (const proof of proofs) {
          parentCaps.push(...proof.capabilities())
        }
      }

      if (Number.isInteger(parsedIndex)) {
        parentCaps.push(...proofs[parsedIndex].capabilities())
      }
    }

    const parsed = semantics.tryParsing(cap)
    if (parsed !== null) {
      yield parsed
    }
  }

  for (const parentCap of parentCaps) {
    const parsed = semantics.tryParsing(parentCap)
    if (parsed !== null) {
      yield parsed
    }
  }
}

/**
 * Can ucan delegate capability with semantics
 *
 * @template A
 * @param {UcanChain} ucan
 * @param {A} capParsed
 * @param {import('ucans').CapabilitySemantics<A>} semantics
 */
function canDelegate(ucan, capParsed, semantics) {
  const ucanCapsParsed = findValidCaps(semantics, ucan)
  let escalation

  for (const ucanCapParsed of ucanCapsParsed) {
    const result = semantics.tryDelegating(ucanCapParsed, capParsed)

    if (isCapabilityEscalation(result)) {
      escalation = result
    } else if (result !== null) {
      return { value: ucanCapParsed }
    }
  }

  return {
    error: escalation
      ? new Error(escalation.escalation)
      : new Error('Not found.'),
  }
}

/**
 * Find root ucan for capability with semantics
 *
 * @template A
 * @param {UcanChain} ucan
 * @param {A} capParsed
 * @param {import('ucans').CapabilitySemantics<A>} semantics
 * @returns {UcanChain | undefined}
 */
function findRoot(ucan, capParsed, semantics) {
  const proofs = ucan.proofs()
  if (proofs.length === 0) {
    return ucan
  } else {
    let lastError
    for (const parent of proofs) {
      const { value, error } = canDelegate(parent, capParsed, semantics)
      if (value) {
        return findRoot(parent, value, semantics)
      } else {
        lastError = error
      }
    }
    throw lastError
  }
}

export class UcanChain {
  /**
   * @param {string} encoded
   * @param {import('ucan-storage/dist/src/types').Ucan<UcanChain>} decoded
   */
  constructor(encoded, decoded) {
    this._encoded = encoded
    this._decoded = decoded
  }

  /**
   * @param {string} encodedUcan
   * @param {import('ucan-storage/dist/src/types').ValidateOptions} options
   * @returns {Promise<UcanChain>}
   */
  static async fromToken(encodedUcan, options) {
    const token = await ucan.validate(encodedUcan, options)

    // parse proofs recursively
    const proofs = await Promise.all(
      token.payload.prf.map((encodedPrf) =>
        UcanChain.fromToken(encodedPrf, options)
      )
    )

    // check sender/receiver matchups. A parent ucan's audience must match the child ucan's issuer
    const incorrectProof = proofs.find(
      (proof) => proof.audience() !== token.payload.iss
    )
    if (incorrectProof) {
      throw new Error(
        `Invalid UCAN: Audience ${incorrectProof.audience()} doesn't match issuer ${
          token.payload.iss
        }`
      )
    }

    const ucanTransformed = {
      ...token,
      payload: {
        ...token.payload,
        prf: proofs,
      },
    }

    return new UcanChain(encodedUcan, ucanTransformed)
  }

  /**
   * Get valid capabilities for the semantics
   *
   * @template A
   * @param {import('ucans').CapabilitySemantics<A>} semantics
   */
  caps(semantics) {
    const validCaps = []
    for (const cap of findValidCaps(semantics, this)) {
      try {
        if (findRoot(this, cap, semantics)) {
          validCaps.push(cap)
        }
      } catch {}
    }

    return validCaps
  }

  /**
   * @template A
   * @param {import('ucan-storage/dist/src/types').Capability} cap
   * @param {import("ucans").CapabilitySemantics<A>} semantics
   */
  claim(cap, semantics) {
    const capParsed = semantics.tryParsing(cap)
    if (capParsed === null) {
      throw new Error('Can not parse cap.')
    }

    const { value, error } = canDelegate(this, capParsed, semantics)
    if (value) {
      return findRoot(this, value, semantics)
    } else {
      throw error
    }
  }

  proofs() {
    return this._decoded.payload.prf
  }

  audience() {
    return this._decoded.payload.aud
  }

  issuer() {
    return this._decoded.payload.iss
  }

  /**
   * The payload the top level represented by this Chain element.
   * Its proofs are omitted. To access proofs, use `.proofs()`
   *
   * @returns {import('ucan-storage/dist/src/types').Ucan<never>}
   */
  payload() {
    return {
      ...this._decoded,
      payload: {
        ...this._decoded.payload,
        prf: [],
      },
    }
  }

  /**
   *
   * @returns {import('ucan-storage/dist/src/types').Capability[]}
   */
  capabilities() {
    // @ts-ignore
    return this._decoded.payload.att
  }
}
