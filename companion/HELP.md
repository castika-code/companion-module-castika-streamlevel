# Castika StreamLevel

Draws OBS audio levels on your buttons.

First, in OBS, open Tools, then WebSocket Server Settings, and check Enable WebSocket server. Then fill in the three settings it gives you:

- **OBS IP / Hostname** is the machine OBS runs on, `127.0.0.1` if that is this one.
- **OBS Port** and **OBS Password** are the ones that dialog shows.

Without the server OBS reports nothing and the buttons stay dark. The module never changes an OBS setting for you.

## Settings

- **Connection Type** stays on plain WebSocket unless OBS is reached through a proxy that terminates TLS.
- **Meter Colors** has to match the preset chosen in OBS under Settings, Accessibility, Color Preset, or the buttons disagree with the mixer. Colors changed there one at a time rather than as a preset cannot be followed.
- **Meter Style** **Stripes** paints the three bands flat with a hard edge where they turn, as the OBS mixer does. **Gradient** blends them, turning color at the same levels.
- **Meter Scale** where a level is drawn, not what it means. It is the scale for every button on this connection, and a button cannot pick another.
- **Loudness Line** how the dark line inside the bar behaves. **Steady** agrees with the OBS mixer; **Follows every change** draws each reading as it arrives. The bar itself is unaffected either way.

## Colors and scales

The three bands a bar is painted in:

- **Up to -20 dBFS** green, or magenta in the color blind set.
- **-20 to -9 dBFS** yellow, or orange.
- **Above -9 dBFS** red, or light teal.

The empty part of a bar is solid: that is a meter reading quiet. A bar hatched in gray and hollow rather than filled is the opposite claim: nothing is being measured at all. Every scale is floored at -60 dBFS and turns color at those same two levels, and **Regular**, the default, stands at the height the bar in the OBS mixer stands at. The fader knob is never affected: it always moves on even decibels. The scales differ in how much of the bar the top twenty decibels get:

        Meter Scale          -20 dBFS   -9 dBFS   between them
        Regular                 66.7%     85.0%       18.3%
        Expanded top 1/2        50.0%     77.5%       27.5%
        Expanded top 2/3        33.3%     70.0%       36.7%
        Expanded top 3/4        25.0%     66.3%       41.3%

## Putting a meter on a button

- **Presets.** One for the program mix, and three for every input in your OBS, each named after the input and saying which side of the fader it watches: **Desktop Audio (in and out)**, **Desktop Audio (out)**, **Desktop Audio (in)**. The list follows OBS, so add, remove or rename an input there and the presets change with it. Before OBS has been reached a single **Audio level** preset appears instead; drop it and pick the input once OBS is connected.
- **The name on the button.** A preset puts the first word of its input's name there, and at most eight characters of that, so a preset for **Desktop Audio** lands a button reading `Desktop`. Clear the button's text for a bare meter.
- **Building a button by hand** takes two steps in this order: add an **Image** element to the button first, then add the **Audio level** feedback. The other way round, the button stays dark and says nothing about why.
- **A taller or wider meter** is made by putting the same input on the buttons next to it. Buttons that touch each other and match on connection, **Input Audio**, **Fader Side**, **Scale** and **Meter Size** join into one meter covering the ground they occupy. Every button in it draws its own text, so leave the name on the first one and clear the text on the rest, and a button left with no bar to carry stays black at the end away from the fader.
- **Meter Size** decides how near the top and bottom of the button the bars reach. **Compact** keeps a band clear at each end, which is where Companion draws the button's text. **Max** keeps about half as much, so the bars gain height for unlabeled buttons. Two buttons on different sizes do not join.
- **Noise floor**, a button's other **Scale**, is a different window, -90 to -30 dBFS, for the question asked before going live: with nobody speaking, how loud is the room. A microphone in a quiet room measures around -57 dBFS, a sliver on the ordinary scale and about 55 percent of the bar in this one, where a few decibels of hum or fan noise are plainly visible. Anything above -30 dBFS pins to the top, every color is the lowest band, and the -9 dBFS line is not drawn: here you read the height. Such a button stays a meter of its own, and its neighbors go on as they were.

## Reading a button

A button is read left to right, the way the signal runs: the bars before the fader are on the left, the fader is in the middle, and the bars after it are on the right. The ones on the left are the source's own level, past any filters on it; the ones on the right are what leaves it. A left bar moving while the right one lies flat is sound coming in and not going out, and the fader between them says whether that was on purpose. A button can be set to watch one side only, and the mix shows one group of bars instead of two. The bars before the fader are drawn dimmer, so the eye lands on what is leaving.

What a working meter shows:

- **A bar filling from the bottom**: the peak. It rises the instant the sound does and falls back at a steady rate, as the OBS mixer does.
- **A dark line inside the filled part**: the loudness, which lags behind the peak. Drawn on the bars after the fader.
- **A white line above the bar**: the highest the level has been lately. It stands for four seconds on the bars after the fader and one on those before it.
- **A thin red line across the bar**: the permitted maximum, -9 dBFS. Drawn on the empty bar as well, so you see where it is before the level arrives.
- **The strip above a bar**: that channel's level as a single color, readable from much further away than the bar. Dark gray means nothing is being measured.
- **Blue strip under a bar**: the source is open.
- **The unfilled part of a bar before the fader blue rather than gray**: the source carries a filter that is switched on.

What says the sound is not going out, or is not being measured:

- **Red strip under a bar**: the source is muted.
- **Bars hatched in gray, hollow rather than filled**: nothing is being measured, because the source is not live or OBS is not connected.
- **A gray knob on the fader of a hatched meter**: where that source's fader stands, as it was last read.
- **A bold diagonal struck across the button, over hollow bars and no fader knob**: the **Input Audio** setting names an input this connection does not have. Nothing is wrong with the sound; the button is pointed at nothing.

There is one strip per channel, so the strips can disagree. A stereo source with one segment hotter than the other is a channel running hot on its own, and a hot strip before the fader with a quiet one after it is a source running hot with the fader holding it down.

**The whole button flashing,** on and off once a second, means the source does not feed the audio track your stream sends: nothing on it reaches the broadcast however good the level looks. The bars keep moving and keep their heights through the flash, and the fader and the mute strip keep their ordinary colors. Which track the stream sends is a profile setting in OBS, under Settings, Output, in advanced mode; in simple mode it is always track 1.

## Things that will otherwise puzzle you

- **A source out of the scene reports nothing at all.** OBS reports levels for active inputs only, so a source that is not in the current scene is left out of the report altogether, even while its own mixer shows it moving. Its button draws hatched bars rather than a flat line, and the fader knob stays where that fader really stands. To check a microphone before taking its scene live, put it in Settings, Audio as a global device: global devices are measurable the whole time OBS runs.
- **A button moved to another connection loses its input.** The setting holds the identifier OBS gave that input, and the OBS on the other connection has never heard of it. The button is struck through rather than hatched, because the two mean opposite things: a source out of the scene comes back by itself, an input that is not here never does. Pick the input again.
- **A lost connection keeps what it learned.** The fader knob and the input list survive it, and anything OBS has since dropped disappears when the connection returns.
- **Desktop audio.** On Windows OBS can capture what the computer is playing, and it appears as Desktop Audio. macOS has no such capture of its own, so on a Mac only what OBS has been given shows up.
- **The mix is an estimate.** OBS publishes no meter for the final mix, so `PGM-MIX` is worked out from the inputs that feed the track your stream sends. It follows the mix closely and it is not the same measurement; the per input meters beside it are what OBS itself reports. A mix has no fader and no mute of its own, so its knob stands at unity and is drawn dull, and the strip under its bars is the open blue.
