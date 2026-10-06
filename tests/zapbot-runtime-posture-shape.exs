# Evaluate both actual nested public-shape accesses from the application checker.
source = File.read!(Path.join(__DIR__, "verify-schema-242-runtime-compatibility.exs"))
accesses = Regex.scan(~r/true = (posture\.checks\.[^\n]+)/, source) |> Enum.map(&Enum.at(&1, 1))
true = length(accesses) == 2

for {posture, accepted} <- [
      {%{
         checks: %{
           prepared_intent_venue_store_contract_exact?: true,
           prepared_intent_venue_consumption_store_contract_exact?: true
         }
       }, true},
      {%{
         checks: %{
           prepared_intent_venue_store_contract_exact?: false,
           prepared_intent_venue_consumption_store_contract_exact?: true
         }
       }, false},
      {%{
         checks: %{
           prepared_intent_venue_store_contract_exact?: true,
           prepared_intent_venue_consumption_store_contract_exact?: false
         }
       }, false},
      {%{checks: %{prepared_intent_venue_store_contract_exact?: true}}, false},
      {%{checks: %{}}, false},
      {%{
         prepared_intent_venue_store_contract_exact?: true,
         prepared_intent_venue_consumption_store_contract_exact?: true
       }, false}
    ] do
  outcome =
    try do
      for access <- accesses,
          do: {true, _} = Code.eval_string("true = " <> access, posture: posture)

      true
    rescue
      _ in [KeyError, MatchError] -> false
    end

  true = outcome == accepted
end

IO.puts("public_posture_shape_regression=pass cases=6")
