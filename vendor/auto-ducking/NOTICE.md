# Auto Ducking integration

`core.py` is the original Auto Ducking Lab implementation, integrated unchanged into SceneRecast with the project owner's permission. It contains the original speech grouping, interval padding, gain-envelope generation and FFmpeg music mixing implementation. No runtime files, samples, credentials or configuration were copied.

`bridge.py` adapts this existing core to the Node application. The mixer receives a voice-only video, so it preserves the converted dialogue while ducking the continuous music bed. Python 3 and FFmpeg are required. Default music levels in the host app are adjusted for its normalized soundtrack, while the original core is unchanged.
