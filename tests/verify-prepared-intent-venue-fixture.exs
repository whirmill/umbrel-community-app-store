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
true = Base.encode16(:crypto.hash(:sha256, File.read!("/package-fixture/zapbot-venue-store.sql")), case: :lower) == "e64f4383d753164643a994164e4a9c9451bd8cbe1b0db63e3584c867e62bc75b"
true = Base.encode16(:crypto.hash(:sha256, File.read!("/package-fixture/zapbot-venue-contract.sql")), case: :lower) == "0ce681b02457b670320721042e27b4072b7c03da54adec3bbe965e921e41de9a"
manifest = Jason.decode!(bytes)
true = manifest["authority"] == "none"
true = manifest["consumption_qualified"] == false
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
    Postgrex.query!(conn, File.read!("/package-fixture/zapbot-venue-contract.sql"), []).rows

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

  rows = %{"pins" => pin, "profiles" => profile, "bindings" => binding}
  baseline = System.fetch_env!("ZAPBOT_VENUE_ROW_BASELINE")
  if System.get_env("ZAPBOT_CONSUMPTION_CAPTURE_BASELINE") == "1" do
    false = File.exists?(baseline)
    File.write!(baseline, Profile.canonical(rows), [:exclusive])
    File.chmod!(baseline, 0o600)
  else
    true = Jason.decode!(File.read!(baseline)) === rows
  end
  IO.puts("venue_three_whole_rows_ids_original_bytes_physical_clocks=pass")
  IO.puts(
    "venue_fixture_archival_crypto_and_exact_projections=pass authority=none current_validity_qualified=false consumption_qualified=false live_actions=0"
  )
after
  GenServer.stop(conn)
end
