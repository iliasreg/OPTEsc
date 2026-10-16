// Runs fire simulations off the page's main thread. The simulation is loaded with the same
// version tag as this worker's own URL, so a cached copy of either can never be mixed in.
// (the handler is attached at once and waits for the module, so no message is lost meanwhile)
const loading = import(new URL(`./sim.js${self.location.search}`, import.meta.url));

self.onmessage = async (e) => {
  const { id, cmd, site, opts } = e.data;
  try {
    const { simulate, worstFire, assess } = await loading;
    if (cmd === 'run') {
      const r = simulate(site, opts);
      // hand over the big arrays instead of copying them (the zone model has no smokeT or tau)
      const buffers = [...r.frames.pos, ...r.frames.state, r.hazard.fireT, r.hazard.smokeT, r.hazard.tau].filter((a) => a?.buffer).map((a) => a.buffer);
      self.postMessage({ id, result: r }, buffers);
    } else if (cmd === 'assess') {
      const r = assess(site, opts, opts.runs || 20, (done, total) => self.postMessage({ id, progress: [done, total] }));
      self.postMessage({ id, result: r });
    } else if (cmd === 'worst') {
      const r = worstFire(site, opts, (done, total) => self.postMessage({ id, progress: [done, total] }));
      self.postMessage({ id, result: r });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
