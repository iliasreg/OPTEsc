// Runs fire simulations off the page's main thread.
import { simulate, worstFire } from './sim.js';

self.onmessage = (e) => {
  const { id, cmd, site, opts } = e.data;
  try {
    if (cmd === 'run') {
      const r = simulate(site, opts);
      const buffers = [...r.frames.pos, ...r.frames.state, r.hazard.fireT, r.hazard.smokeT, r.hazard.tau].map((a) => a.buffer);
      self.postMessage({ id, result: r }, buffers);
    } else if (cmd === 'worst') {
      const r = worstFire(site, opts, (done, total) => self.postMessage({ id, progress: [done, total] }));
      self.postMessage({ id, result: r });
    }
  } catch (err) {
    self.postMessage({ id, error: err.message });
  }
};
