# Minimal UDP fixture: no forwarding, credentials, public DNS or application boot.
defmodule DNSFixture do
  def start do
    {:ok, socket} = :gen_udp.open(53, [:binary, active: false, ip: {0, 0, 0, 0}])
    if System.fetch_env!("DNS_FIXTURE_MODE") == "answer", do: spawn(fn -> http_server() end)
    IO.puts("dns_fixture_ready")
    loop(socket, System.fetch_env!("DNS_FIXTURE_MODE"))
  end

  defp loop(socket, mode) do
    {:ok, {ip, port, packet}} = :gen_udp.recv(socket, 0)
    if mode == "answer" and not :persistent_term.get(:drop_dns, false), do: answer(socket, ip, port, packet)
    loop(socket, mode)
  end

  defp answer(socket, ip, port, <<id::16, _flags::16, 1::16, _::48, rest::binary>>) do
    {labels, <<type::16, class::16, _::binary>>, name_size} = name(rest, [], 0)
    question = binary_part(rest, 0, name_size + 4)
    valid = List.last(labels) == "invalid" and class == 1
    address = if String.starts_with?(hd(labels), "http-") do
      {:ok, value} = :inet.getaddr(String.to_charlist(System.fetch_env!("HOSTNAME")), :inet)
      value
    else
      {192, 0, 2, 123}
    end
    {a, b, c, d} = address
    record = if valid and type == 1, do: <<0xC00C::16, 1::16, 1::16, 0::32, 4::16, a, b, c, d>>, else: <<>>
    flags = if valid, do: 0x8180, else: 0x8183
    count = if record == <<>>, do: 0, else: 1
    :ok = :gen_udp.send(socket, ip, port, <<id::16, flags::16, 1::16, count::16, 0::16, 0::16, question::binary, record::binary>>)
  end
  defp answer(_, _, _, _), do: :ok
  defp http_server do
    {:ok, listener} = :gen_tcp.listen(8080, [:binary, active: false, reuseaddr: true])
    http_accept(listener)
  end
  defp http_accept(listener) do
    {:ok, socket} = :gen_tcp.accept(listener)
    case :gen_tcp.recv(socket, 0, 5000) do
      {:ok, "GET /drop " <> _} -> :persistent_term.put(:drop_dns, true)
      {:ok, "GET /answer " <> _} -> :persistent_term.put(:drop_dns, false)
      _ -> :ok
    end
    :gen_tcp.send(socket, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
    :gen_tcp.close(socket)
    http_accept(listener)
  end
  defp name(<<0, tail::binary>>, labels, size), do: {Enum.reverse(labels), tail, size + 1}
  defp name(<<len, label::binary-size(len), tail::binary>>, labels, size), do: name(tail, [label | labels], size + len + 1)
end
DNSFixture.start()
