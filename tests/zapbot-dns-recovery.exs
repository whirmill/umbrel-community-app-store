# Reuse the same VM, native helper and Req/Finch supervision tree across outage.
{:ok, _} = Application.ensure_all_started(:req)
2000 = :inet_db.res_option(:timeout)
options = [retry: false, receive_timeout: 15_000, pool_timeout: 5_000,
           connect_options: [timeout: 1_000, protocols: [:http1]]]
url = "http://http-same-process.invalid:8080"

within_five_seconds = fn ->
  task = Task.async(fn -> Req.get(url, options) end)
  case Task.yield(task, 5_000) || Task.shutdown(task, :brutal_kill) do
    {:ok, {:ok, %{status: 200, body: "ok"}}} -> :ok
    other -> raise "healthy acquisition exceeded unchanged five-second outer budget: #{inspect(other)}"
  end
end

within_five_seconds.()
8000 = :persistent_term.get({:inet_gethost_native, :timeout})
set_mode = fn mode ->
  for address <- System.argv() do
    {:ok, %{status: 200}} = Req.get("http://#{address}:8080/#{mode}", options)
  end
end
set_mode.("drop")
started = System.monotonic_time(:millisecond)
{:error, %Req.TransportError{reason: reason}} = Req.get(url, options)
true = reason in [:nxdomain, :timeout]
elapsed = System.monotonic_time(:millisecond) - started
true = elapsed < 15_000
IO.puts("same_process_outage=pass error=#{reason} elapsed_ms=#{elapsed}")
set_mode.("answer")
within_five_seconds.()
2000 = :inet_db.res_option(:timeout)
8000 = :persistent_term.get({:inet_gethost_native, :timeout})
IO.puts("same_process_recovery=pass connect_timeout_ms=1000 outer_budget_ms=5000 native_timeout_ms=8000")
