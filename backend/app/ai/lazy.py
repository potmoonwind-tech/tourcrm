"""The Anthropic library, loaded the first time it is used (not when the app starts).

The app starts, and its tests run, without it: only the AI features (the assistant, smart import, reading a
menu photo) load it. `anthropic.X` works as usual - `except anthropic.APIStatusError` included, since
that name is looked up only when an error is being matched.
"""


class _Lazy:
    def __getattr__(self, name: str):
        import anthropic as real
        return getattr(real, name)


anthropic = _Lazy()
