package classifier

import "testing"

func TestMatchPicksTheLongestPrefix(t *testing.T) {
	t.Parallel()

	entries := []Entry{
		{Prefix: []string{"docker", "run"}, Ask: "run"},
		{Prefix: []string{"docker"}, Ask: "docker"},
		{Prefix: []string{"docker", "run", "--privileged"}, Ask: "privileged"},
	}
	tests := []struct {
		command string
		args    []string
		want    string
	}{
		{command: "docker", args: []string{"docker", "ps"}, want: "docker"},
		{command: "docker", args: []string{"/usr/local/bin/docker", "run", "alpine"}, want: "run"},
		{command: "docker", args: []string{"docker", "run", "--privileged", "alpine"}, want: "privileged"},
		{command: "docker", args: []string{"docker"}, want: "docker"},
		{command: "docker", args: []string{"docker", "image", "run"}, want: "docker"},
		{command: "dockerd", args: []string{"dockerd"}, want: ""},
		{command: "podman", args: []string{"docker", "run"}, want: ""},
	}
	for _, test := range tests {
		entry, matched := Match(entries, test.command, test.args)
		if got := entry.Ask; got != test.want || matched != (test.want != "") {
			t.Errorf("Match(%q, %q) = %q, %v, want %q", test.command, test.args, got, matched, test.want)
		}
	}
}
