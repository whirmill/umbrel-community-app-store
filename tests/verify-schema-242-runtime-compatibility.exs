# Actual application boot, isolated synthetic DB only; no venue authority.
true = System.get_env("ZAPBOT_COMPAT_DISPOSABLE") == "1"
true = System.get_env("ZAPBOT_OBSERVATION_ONLY") == "true"
for name <- ~w[LNM_API_KEY LNM_API_SECRET LNM_API_PASSPHRASE AGENT_API_TOKEN AGENT_CONTROL_API_TOKEN],
  do: true = System.get_env(name) in [nil, ""]
true = Enum.all?(Application.started_applications(), fn {name, _, _} -> name not in [:api, :hub, :cli] end)
Application.load(:api)
config = Zapbot.Repo.config()
  |> Keyword.drop([:url, :name, :pool])
  |> Keyword.merge(hostname: "package-postgres", port: 5432, database: "zapbot",
    username: "zapbot_runtime", password: File.read!("/run/package-runtime/password") |> String.trim(),
    ssl: false, pool_size: 2)
Application.put_env(:api, Zapbot.Repo, config)
Application.put_env(:api, :runtime_environment_mode, "production")
Application.put_env(:api, :start_repo, true)
Application.put_env(:api, :start_internal_consumers, false)
Application.put_env(:api, :start_deliberation_runtime, false)
Application.put_env(:api, :lnm_startup_reconcile_enabled, false)
Application.put_env(:api, ZapbotWeb.Endpoint,
  Application.get_env(:api, ZapbotWeb.Endpoint, []) |> Keyword.merge(server: false, secret_key_base: File.read!("/run/package-runtime/secret-key-base") |> String.trim()))
Application.put_env(:api, Oban,
  Application.fetch_env!(:api, Oban) |> Keyword.merge(plugins: [], queues: false, testing: :manual))
{:ok, _} = Application.ensure_all_started(:api)
try do
  true = is_pid(Process.whereis(Zapbot.Supervisor))
  true = is_pid(Process.whereis(Zapbot.Repo))
  true = not Zapbot.ObanConfig.background_execution_enabled?()
  true = not Zapbot.ObanConfig.startup_reconcile_enabled?()
  false = Application.get_env(:api, :start_internal_consumers)
  true = Keyword.get(Zapbot.ObanConfig.runtime_config(), :queues) == false
  true = Keyword.get(Zapbot.ObanConfig.runtime_config(), :plugins) == []
  true = Enum.all?(Application.started_applications(), fn {name, _, _} -> name not in [:hub, :cli] end)
  for child <- [Zapbot.Deliberation.BusConsumer, Zapbot.Deliberation.PendingOrderReactor,
      Zapbot.MarketData.MarketCandlePersister, Zapbot.MarketData.MarketCandleStreamPersister,
      Zapbot.Evidence.PassiveExecutionEvidenceRecorder], do: true = is_nil(Process.whereis(child))
  {:ok, posture} = Zapbot.Security.RuntimeDatabaseRole.posture()
  true = posture.safe?
  if System.fetch_env!("ZAPBOT_COMPAT_GENERATION") == "new242",
    do: true = posture.checks.prepared_intent_venue_store_contract_exact?
  IO.puts("schema242_runtime_application_boot=pass runtime_role_safe=true observation_only=true internal_consumers=false authority=none")
after
  :ok = Application.stop(:api)
end
