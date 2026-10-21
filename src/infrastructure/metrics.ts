import { Job } from "./jobModel.js";
import {
  Registry,
  Gauge,
  Counter,
  Histogram,
  collectDefaultMetrics,
} from "@prometheus-io/client";
export const registry = new Registry();
collectDefaultMetrics({ register: registry });
export const requests = new Counter({
  name: "luma_http_requests_total",
  help: "HTTP responses",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});
export const duration = new Histogram({
  name: "luma_http_duration_seconds",
  help: "HTTP duration",
  labelNames: ["method", "route"],
  registers: [registry],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 3, 10],
});

new Gauge({
  name: "luma_jobs_pending",
  help: "Pending durable jobs",
  registers: [registry],
  async collect() {
    this.set(await Job.countDocuments({ doneAt: null, dead: false }));
  },
});
new Gauge({
  name: "luma_jobs_dead",
  help: "Dead-letter jobs requiring operator review",
  registers: [registry],
  async collect() {
    this.set(await Job.countDocuments({ doneAt: null, dead: true }));
  },
});
new Gauge({
  name: "luma_jobs_ready_lag_seconds",
  help: "Age of oldest ready job",
  registers: [registry],
  async collect() {
    const oldest = await Job.findOne({ doneAt: null, dead: false })
      .sort({ availableAt: 1 })
      .select("availableAt")
      .lean();
    this.set(
      oldest
        ? Math.max(0, (Date.now() - oldest.availableAt.getTime()) / 1000)
        : 0,
    );
  },
});
