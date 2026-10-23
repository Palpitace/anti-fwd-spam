import json
import unittest

from anti_fwd_spam.policy import Config, ConfigError


class ConfigurationTests(unittest.TestCase):
    def test_user_configures_reporters(self) -> None:
        """user: Given mixed user and chat IDs, When configured, Then one list retains both identities."""
        config = Config.from_values(
            bot_token="123:token",
            webhook_secret="secret",
            reporter_ids="11, 4503599627370495,11, -10012,-4503599627370495",
        )
        self.assertEqual(config.reporter_ids, {11, 4503599627370495, -10012, -4503599627370495})
        empty = Config.from_values(bot_token="123:token", webhook_secret="secret")
        self.assertFalse(empty.reporter_ids)
        self.assertFalse(empty.content_allowlist)

    def test_user_configures_content_exemptions_separately_for_each_group(self) -> None:
        """user: A content exemption is a group/user pair and grants no reporting authority."""
        config = Config.from_values(
            bot_token="123:token",
            webhook_secret="secret",
            content_allowlist='{"-10012": [22, 33, 22], "-10013": [44], "-10014": []}',
        )
        self.assertEqual(config.content_allowlist, {(-10012, 22), (-10012, 33), (-10013, 44)})
        self.assertFalse(config.reporter_ids)
        for value in ("", "  ", "{}"):
            with self.subTest(value=value):
                empty = Config.from_values(bot_token="123:token", webhook_secret="secret", content_allowlist=value)
                self.assertFalse(empty.content_allowlist)

    def test_user_rejects_malformed_or_unbounded_content_exemptions(self) -> None:
        """user: Invalid exemptions fail configuration instead of creating a global bypass."""
        for value in (
            None,
            {},
            "x" * 4097,
            "null",
            "[]",
            "true",
            '{"-10012": [22]',
            '{"10012": [22]}',
            '{"0": [22]}',
            '{"-0": [22]}',
            '{"-010012": [22]}',
            '{"-١٢": [22]}',
            '{"-10012": 22}',
            '{"-10012": null}',
            '{"-4503599627370496": [22]}',
            json.dumps({"-10012": [22] * 501}),
            json.dumps({"-10012": [22] * 250, "-10013": [33] * 251}),
            *(json.dumps({"-10012": [member]}) for member in (0, -22, True, 22.0, "22", None, {}, [], 2**52)),
        ):
            with self.subTest(value=value), self.assertRaises(ConfigError):
                Config.from_values(bot_token="123:token", webhook_secret="secret", content_allowlist=value)

    def test_user_accepts_content_exemptions_at_the_supported_limits(self) -> None:
        """user: Valid boundary IDs and the entry limit remain accepted."""
        config = Config.from_values(
            bot_token="123:token",
            webhook_secret="secret",
            content_allowlist=json.dumps({"-4503599627370495": [4503599627370495], "-10012": [22] * 499}),
        )
        self.assertEqual(config.content_allowlist, {(-4503599627370495, 4503599627370495), (-10012, 22)})

    def test_user_rejects_invalid_reporter_configuration(self) -> None:
        """user: Given malformed identity lists, When configured, Then no permissive fallback is enabled."""
        for value in (None, [], "0", "4503599627370496", "@someone", "1.0", "true", "\u0661\u0661", "1," * 501):
            with self.subTest(value=value), self.assertRaises(ConfigError):
                Config.from_values(bot_token="123:token", webhook_secret="secret", reporter_ids=value)

    def test_user_rejects_invalid_configuration(self) -> None:
        """user: Given invalid credentials, When configured, Then startup fails explicitly."""
        for replacement in (
            {"bot_token": "bad"},
            {"bot_token": "0:token"},
            {"webhook_secret": "é"},
        ):
            with self.subTest(replacement=replacement), self.assertRaises(ConfigError):
                Config.from_values(**{"bot_token": "123:token", "webhook_secret": "secret", **replacement})
