# Archival cryptographic/projection verification at the manifest's original
# clock. This never qualifies current validity, enrollment or consumption.
unless System.get_env("ZAPBOT_VENUE_STORE_DISPOSABLE") == "1",
  do: raise("venue fixture verifier requires an explicit disposable target")

for app <- [:logger, :crypto, :postgrex], do: Application.ensure_all_started(app)
Logger.configure(level: :warning)
alias Zapbot.Research.LNMarkets.PreparedIntentVenueProfile, as: Profile
alias Zapbot.Research.LNMarkets.PreparedIntentVenueArtifact, as: Intent
alias Zapbot.Research.LNMarkets.PreparedIntentVenueWireArtifact, as: Wire

manifest_path =
  System.get_env("ZAPBOT_VENUE_MANIFEST") ||
    Path.expand("../tests/fixtures/zapbot-venue-store.json", __DIR__)

bytes = File.read!(manifest_path)
expected = "59cef0547fa097eda8912175328dfe43efc4909a0530f854f4526f4cd8fb2161"
true = Base.encode16(:crypto.hash(:sha256, bytes), case: :lower) == expected
manifest = Jason.decode!(bytes)
pins = Map.update!(manifest["pins"], "governance_public_key", &Base.decode16!(&1, case: :lower))
as_of = manifest["historical_as_of"]
config = Zapbot.Repo.config() |> Keyword.drop([:name, :pool, :pool_size, :after_connect])

unless config[:hostname] in ["127.0.0.1", "localhost", "::1"] and is_nil(config[:url]) and
         Regex.match?(
           ~r/\Azapbot_(test|clean|upgrade|restore)(?:_[a-zA-Z0-9_]+)?\z/,
           config[:database] || ""
         ),
       do: raise("venue fixture verifier refused nonlocal or non-disposable target")

{:ok, conn} = Postgrex.start_link(config)

try do
  [[database]] = Postgrex.query!(conn, "SELECT current_database()", []).rows
  true = database == config[:database]
  Postgrex.query!(conn, "SET ROLE zapbot_owner", [])

  [[true]] =
    Postgrex.query!(conn, Zapbot.Release.LNMarketsPreparedIntentVenueStore.contract_sql(), []).rows

  read = fn table, id ->
    [[json]] =
      Postgrex.query!(
        conn,
        "SELECT row_to_json(r)::text FROM public.#{table} r WHERE id=$1::text::uuid",
        [id]
      ).rows

    Jason.decode!(json)
  end

  pin = read.("lnm_prepared_intent_venue_pins", manifest["pin_id"])
  profile = read.("lnm_prepared_intent_venue_profiles", manifest["profile_row_id"])
  binding = read.("lnm_prepared_intent_venue_bindings", manifest["binding_id"])

  true =
    pin["governance_public_key"] ==
      "\\x" <> Base.encode16(pins["governance_public_key"], case: :lower)

  true = pin["expected_profile_id"] == pins["expected_profile_id"]
  true = pin["expected_profile_hash"] == pins["expected_profile_hash"]
  true = pin["context_json"] == Profile.canonical(pins["trusted_context"])
  true = profile["pin_id"] == pin["id"]
  true = profile["envelope_json"] == Profile.canonical(manifest["profile"])
  true = profile["profile_json"] == Profile.canonical(manifest["profile"]["profile"])
  true = profile["profile_hash"] == pins["expected_profile_hash"]
  true = binding["profile_row_id"] == profile["id"]
  true = binding["envelope_json"] == Profile.canonical(manifest["parent"])
  true = binding["artifact_json"] == Profile.canonical(manifest["parent"]["artifact"])
  true = binding["request_json"] == Profile.canonical(manifest["parent"]["artifact"]["request"])
  true = binding["wire_json"] == Profile.canonical(manifest["wire"])

  true =
    binding["entity_bytes"] ==
      "\\x" <> Base.encode16(manifest["wire"]["entity_bytes"], case: :lower)

  true = binding["binding_json"] == Profile.canonical(manifest["binding"])
  true = binding["binding_hash"] == manifest["binding_hash"]
  true = binding["parent_envelope_hash"] == manifest["wire"]["parent_envelope_hash"]
  true = binding["wire_hash"] == manifest["wire"]["wire_hash"]
  artifact = manifest["parent"]["artifact"]

  for key <-
        ~w(environment_id account_id market_key command_id preparation_id attempt_id prepared_at),
      do: true = binding[key] == artifact[key]

  true = binding["client_id"] == artifact["request"]["clientId"]
  {:ok, _} = Profile.authenticate(Jason.decode!(profile["envelope_json"]), pins, as_of)

  {:ok, ^artifact} =
    Intent.verify(Jason.decode!(binding["envelope_json"]), manifest["profile"], pins, as_of)

  {:ok, wire} =
    Wire.verify(
      Jason.decode!(binding["wire_json"]),
      manifest["parent"],
      manifest["profile"],
      pins,
      as_of,
      []
    )

  true = wire === manifest["wire"]
  true = binding["request_json"] =~ "\"leverage\":10.0"
  true = wire["entity_bytes"] =~ "\"leverage\":10,"

  IO.puts(
    "venue_immutable_archival_subcheck=pass authority=none current_validity_qualified=false consumption_qualified=false live_actions=0"
  )
after
  GenServer.stop(conn)
end

# Both original VENUE signatures and fourth-table structural projections are
# historical verification only; this cannot replay a consumption acknowledgement.
consumption_manifest_path =
  System.get_env("ZAPBOT_VENUE_CONSUMPTION_MANIFEST") ||
    Path.expand("../tests/fixtures/zapbot-venue-consumption.json", __DIR__)

consumption_bytes = File.read!(consumption_manifest_path)

true =
  Base.encode16(:crypto.hash(:sha256, consumption_bytes), case: :lower) ==
    "609b4a5359f5981e499cbf97e36c167728395cf6b657d68402d2bda27882cbad"

consumption_manifest = Jason.decode!(consumption_bytes)
true = consumption_manifest["venue_manifest_sha256"] == expected
true = consumption_manifest["historical_as_of"] == as_of
claim = consumption_manifest["claim"]

true =
  Profile.digest("zapbot:lnmarkets_prepared_intent_venue_consumption@v1", "claim", claim) ==
    consumption_manifest["claim_hash"]

true = claim["binding_id"] == manifest["binding_id"]
true = claim["profile_row_id"] == manifest["profile_row_id"]
true = claim["pin_id"] == manifest["pin_id"]
true = claim["binding_hash"] == manifest["binding_hash"]
true = claim["wire_hash"] == manifest["wire"]["wire_hash"]
true = claim["parent_envelope_hash"] == manifest["wire"]["parent_envelope_hash"]
true = claim["expected_profile_hash"] == pins["expected_profile_hash"]

for key <-
      ~w(environment_id account_id market_key command_id preparation_id attempt_id application_revision),
    do: true = claim[key] == manifest["parent"]["artifact"][key]

true = claim["client_id"] == manifest["parent"]["artifact"]["request"]["clientId"]
true = claim["policy_version"] == "venue_consumption@v1"
{:ok, consumption_conn} = Postgrex.start_link(config)

try do
  Postgrex.query!(consumption_conn, "SET ROLE zapbot_owner", [])
  Postgrex.query!(consumption_conn, "SET search_path=pg_catalog,public", [])

  [[true]] =
    Postgrex.query!(
      consumption_conn,
      Zapbot.Release.LNMarketsPreparedIntentVenueStore.contract_sql(),
      []
    ).rows

  [[true]] =
    Postgrex.query!(
      consumption_conn,
      Zapbot.Release.LNMarketsPreparedIntentVenueStore.consumption_contract_sql(),
      []
    ).rows

  [[json]] =
    Postgrex.query!(
      consumption_conn,
      "SELECT row_to_json(r)::text FROM public.lnm_prepared_intent_venue_consumptions r WHERE id=$1::text::uuid",
      [consumption_manifest["consumption_id"]]
    ).rows

  row = Jason.decode!(json)
  true = row["claim_json"] == Profile.canonical(claim)
  true = row["claim_hash"] == consumption_manifest["claim_hash"]
  for key <- Map.keys(claim) -- ~w(pin_id profile_row_id), do: true = row[key] == claim[key]
  true = is_binary(row["consumed_by"]) and byte_size(row["consumed_by"]) > 0
  {:ok, _, _offset} = DateTime.from_iso8601(row["consumed_at"])

  IO.puts(
    "venue_consumption_fixture_archival_crypto_and_exact_projections=pass authority=none current_validity_qualified=false consumption_qualified=false live_actions=0"
  )
after
  GenServer.stop(consumption_conn)
end
