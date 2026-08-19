function normaliseVersion(value) {
  const version = String(value || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`适配器版本格式不正确：${version}`);
  return version;
}

function normaliseName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(name)) throw new Error(`适配器名称格式不正确：${name}`);
  return name;
}

export class AdapterRegistry {
  #entries = new Map();

  register({ name, version, harness = null, capabilities = [], adapter, metadata = {} } = {}) {
    const normalizedName = normaliseName(name);
    const normalizedVersion = normaliseVersion(version);
    if (typeof adapter !== 'function' && typeof adapter !== 'object') throw new Error(`适配器 ${normalizedName} 缺少实现`);
    const key = `${normalizedName}@${normalizedVersion}`;
    const entry = Object.freeze({
      name: normalizedName,
      version: normalizedVersion,
      harness: harness ? String(harness) : null,
      capabilities: [...new Set((capabilities || []).map(String))],
      adapter,
      metadata: { ...metadata },
      registeredAt: new Date().toISOString(),
    });
    this.#entries.set(key, entry);
    return entry;
  }

  get(name, version = null) {
    const normalizedName = normaliseName(name);
    if (version) return this.#entries.get(`${normalizedName}@${normaliseVersion(version)}`) || null;
    const candidates = [...this.#entries.values()].filter((entry) => entry.name === normalizedName);
    return candidates.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))[0] || null;
  }

  list({ harness = null, capability = null } = {}) {
    return [...this.#entries.values()]
      .filter((entry) => !harness || entry.harness === harness)
      .filter((entry) => !capability || entry.capabilities.includes(capability))
      .sort((left, right) => left.name.localeCompare(right.name) || right.version.localeCompare(left.version, undefined, { numeric: true }));
  }

  resolve(name, version = null) {
    const entry = this.get(name, version);
    if (!entry) throw new Error(`未找到适配器：${name}${version ? `@${version}` : ''}`);
    return entry;
  }
}

export function createDefaultAdapterRegistry() {
  return new AdapterRegistry();
}
