# Pure regression against the actual public-shape access in the boot checker.
source = File.read!(Path.join(__DIR__, "verify-schema-242-runtime-compatibility.exs"))
[_, access] = Regex.run(~r/do: true = (posture\.[^\n]+)/, source)
for {posture, accepted} <- [
  {%{safe?: true, reason_codes: [], checks: %{prepared_intent_venue_store_contract_exact?: true}}, true},
  {%{safe?: true, reason_codes: [], checks: %{prepared_intent_venue_store_contract_exact?: false}}, false},
  {%{safe?: true, reason_codes: [], checks: %{}}, false},
  {%{safe?: true, reason_codes: [], prepared_intent_venue_store_contract_exact?: true}, false}
] do
  outcome = try do
    {true, _} = Code.eval_string("true = " <> access, posture: posture)
    true
  rescue
    _ in [KeyError, MatchError] -> false
  end
  true = outcome == accepted
end
IO.puts("public_posture_shape_regression=pass cases=4")
