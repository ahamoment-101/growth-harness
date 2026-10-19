-- Agent model selection is owned by Runtime route configuration, not per-site data.
-- Keep the legacy non-null column compatible while removing stale historical values.
update sites set model = 'runtime-configured';
