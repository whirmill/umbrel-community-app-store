# Offline synthetic fixture verification only. No application/Hub/network start.
unless System.get_env("ZAPBOT_PRECALL_DISPOSABLE") == "1",
  do: raise("explicit disposable fixture confirmation required")

for app <- [:logger, :crypto, :ecto_sql, :postgrex], do: Application.ensure_all_started(app)
Logger.configure(level: :warning)

manifest_path =
  System.get_env("ZAPBOT_CONSUMPTION_MANIFEST") ||
    Path.expand("../tests/fixtures/zapbot-precall-consumption.json", __DIR__)

seed_path =
  System.get_env("ZAPBOT_CONSUMPTION_SEED") ||
    Path.expand("../tests/fixtures/zapbot-precall-consumption.sql", __DIR__)

m = manifest_path |> File.read!() |> Jason.decode!()
true = m["fixture_only"] and m["authority"] == "none"

true =
  m["seed_sha256"] == :crypto.hash(:sha256, File.read!(seed_path)) |> Base.encode16(case: :lower)

{:ok, governance} = Base.decode64(m["governance_key"])

tables =
  ~w(lnm_prepared_intent_contexts lnm_prepared_intent_fixtures lnm_prepared_intent_producer_pins lnm_prepared_intent_governance_profiles lnm_prepared_intent_precall_receipts lnm_prepared_intent_consumptions)

true = Enum.sort(Map.keys(m["expected_projection_rows"])) == Enum.sort(tables)

defmodule ConsumptionFixtureOwner do
  use Ecto.Repo, otp_app: :api, adapter: Ecto.Adapters.Postgres

  def owner(conn) do
    Postgrex.query!(conn, "SET ROLE zapbot_owner", [])
    Postgrex.query!(conn, "SET TIME ZONE 'UTC'", [])
  end
end

defmodule ConsumptionFixtureReader do
  use Ecto.Repo, otp_app: :api, adapter: Ecto.Adapters.Postgres
end

config = Zapbot.Repo.config() |> Keyword.drop([:name, :pool, :after_connect])

unless config[:hostname] in ["127.0.0.1", "localhost", "::1"] and is_nil(config[:url]) and
         Regex.match?(~r/\Azapbot_test(?:_[a-zA-Z0-9_]+)?\z/, config[:database] || ""),
       do: raise("offline fixture checker requires disposable local test database")

config =
  Keyword.merge(config,
    pool: DBConnection.ConnectionPool,
    pool_size: 2,
    after_connect: {ConsumptionFixtureOwner, :owner, []}
  )

{:ok, writer} = ConsumptionFixtureOwner.start_link(config)
{:ok, reader} = ConsumptionFixtureReader.start_link(config)

canonical = fn value ->
  value |> Zapbot.Evidence.CausalEvent.canonical_json() |> IO.iodata_to_binary()
end

try do
  rows =
    Map.new(m["expected_projection_rows"], fn {table, expected} ->
      [[row]] =
        ConsumptionFixtureReader.query!(
          "SELECT to_jsonb(t) FROM public.#{table} t WHERE id=$1::text::uuid",
          [expected["id"]],
          log: false
        ).rows

      projected =
        Map.drop(
          row,
          ~w(registered_at registered_by received_at received_by inserted_at inserted_by consumed_at consumed_by)
        )

      true = projected === expected
      {table, row}
    end)

  pin = rows["lnm_prepared_intent_producer_pins"]
  profile = rows["lnm_prepared_intent_governance_profiles"]
  receipt = rows["lnm_prepared_intent_precall_receipts"]
  parent = Jason.decode!(rows["lnm_prepared_intent_fixtures"]["envelope_json"])
  signed = Jason.decode!(profile["envelope_json"])
  wire = Jason.decode!(receipt["wire_json"])
  {:ok, assessed, _offset} = DateTime.from_iso8601(receipt["assessed_at"])
  # Verify persisted bytes against external frozen fixture pins at historical time;
  # this is not fresh admission and must not ignore expiry in consume_fixture_once.
  {:ok, authenticated} =
    Zapbot.Research.LNMarkets.PreparedIntentProvenanceReadiness.authenticate_profile(
      signed,
      governance,
      assessed
    )

  true = signed === m["profile_envelope"]
  true = profile["profile_json"] == canonical.(authenticated.profile)
  true = pin["context_json"] == canonical.(m["context"])
  true = pin["governance_public_key"] == "\\x" <> Base.encode16(governance, case: :lower)

  true =
    pin["intent_public_key"] == "\\x" <> Base.encode16(authenticated.intent_key, case: :lower)

  {:ok, _} =
    Zapbot.Research.LNMarkets.PreparedIntentArtifact.verify(
      parent,
      authenticated.intent_key,
      m["context"]
    )

  {:ok, rebuilt} =
    Zapbot.Research.LNMarkets.PreparedIntentWireArtifact.verify(
      wire,
      parent,
      authenticated.intent_key,
      m["context"],
      authenticated.profile["fixture_target"]
    )

  true = receipt["wire_json"] == canonical.(rebuilt)
  true = receipt["entity_bytes"] == "\\x" <> Base.encode16(rebuilt["entity_bytes"], case: :lower)

  baseline = System.get_env("ZAPBOT_CONSUMPTION_ROW_BASELINE")

  retention =
    if baseline do
      if System.get_env("ZAPBOT_CONSUMPTION_CAPTURE_BASELINE") == "1" do
        false = File.exists?(baseline)
        File.write!(baseline, canonical.(rows), [:exclusive])
        File.chmod!(baseline, 0o600)
        "captured_whole_rows"
      else
        true = Jason.decode!(File.read!(baseline)) === rows
        "all_six_whole_rows_identical"
      end
    else
      "immutable_projections_identical_actor_clock_baseline_not_supplied"
    end

  expected = [[m["consumption_id"], m["binding_hash"], m["wire_hash"], m["claim_hash"]]]

  sql =
    "SELECT id::text,binding_hash,wire_hash,claim_hash FROM public.lnm_prepared_intent_consumptions WHERE precall_receipt_id=$1::text::uuid"

  true = ConsumptionFixtureReader.query!(sql, [m["receipt_id"]], log: false).rows == expected

  {:error, reason} =
    Zapbot.Release.LNMarketsPreparedIntentPrecallStore.consume_fixture_once(
      ConsumptionFixtureOwner,
      ConsumptionFixtureReader,
      m["receipt_id"],
      %{governance_key: governance, context: m["context"]}
    )

  true = reason in [:already_consumed, :invalid_governance_profile]
  # Expiry rejection alone does not prove consumed identity; the durable UNIQUE
  # rejection independently proves no second claim can be inserted after restore.
  {:error, %Postgrex.Error{postgres: %{code: :unique_violation}}} =
    ConsumptionFixtureOwner.query(
      """
      INSERT INTO public.lnm_prepared_intent_consumptions
      SELECT (jsonb_populate_record(NULL::public.lnm_prepared_intent_consumptions,
        to_jsonb(c) || jsonb_build_object('id',$2::text,'consumed_at',statement_timestamp()))).*
      FROM public.lnm_prepared_intent_consumptions c WHERE precall_receipt_id=$1::text::uuid
      """,
      [m["receipt_id"], Ecto.UUID.generate()],
      log: false
    )

  true = ConsumptionFixtureReader.query!(sql, [m["receipt_id"]], log: false).rows == expected

  IO.puts(
    Jason.encode!(%{
      classification: "synthetic_consumption_verification",
      retention: retention,
      persisted_historical_profile_parent_wire_verified: true,
      consume_rejection: Atom.to_string(reason),
      duplicate_unique_rejection: true,
      authority: "none",
      live_actions_generated: 0
    })
  )
after
  GenServer.stop(reader)
  GenServer.stop(writer)
end
