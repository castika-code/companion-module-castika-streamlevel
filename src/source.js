/**
 * What a source of audio has to answer, and nothing about where it comes from.
 *
 * A source adapter lives in src/sources/ and speaks whatever protocol its
 * machine speaks. The drawing, the feedbacks and the presets know only what is
 * written here, so a second machine is a new file in that folder rather than a
 * change to the picture. It is not a second machine for free: the connection
 * settings form in src/main.js names OBS field by field, and a second adapter
 * would need its own fields there as well as its own file here.
 *
 * FIVE THINGS AN ADAPTER MUST SUPPLY, per source it lists:
 *
 * 1. The reading pair of every channel: `pre`, the level before the fader and
 *    after any filters, and `post`, the level after the fader and the mute.
 *    These are the two bars. A source offering only one of them cannot draw the
 *    distinction this module exists for: a bar moving on the left with the right
 *    one flat is sound arriving and not going out, and with one bar there is no
 *    way to tell that from silence. A third number, `loudness`, travels with the
 *    pair and is the average rather than the peak of what `post` measures.
 * 2. Whether the source is muted.
 * 3. Where its fader sits.
 * 4. Whether it reaches what the stream sends. Routing is not a level and has no
 *    level of its own: a source can be perfectly healthy and inaudible to
 *    everyone watching.
 * 5. Whether it is live at all, which is not the same as being quiet. A source
 *    that is not being mixed has no reading, and a reading of silence is a
 *    different claim.
 *
 * AND TWO MORE AN ADAPTER MAY OFFER OR LEAVE OUT:
 *
 * 6. A mix: what is leaving the machine, offered as one entry in the list beside
 *    the sources that feed it. A machine that meters its own output measures it;
 *    one that does not can only add its members up, which is what the OBS
 *    adapter does and says.
 * 7. The filters each source carries, and which of them are switched on. It is
 *    the one thing on the button that is not a level, and a machine with no such
 *    idea leaves it out rather than reporting none.
 *
 * WHAT AN ADAPTER SHOULD AIM AT is answering all of that from measurement, and
 * saying in its capability record wherever it cannot. The whole use of these
 * buttons is that what they show is true, and a fader invented at unity or a
 * mute assumed open reads exactly like one that was measured. It is an aim
 * rather than a rule, because the first adapter does not meet it: where a
 * request for a mute, a fader or a track fails, the OBS adapter carries on with
 * unmuted, unity gain, and the stream's own track, and its record answers ASSUMED for
 * those three rather than claiming they were read. That is a known weakness, and
 * the comments at those three sites say so.
 *
 * Levels are linear multipliers throughout, full scale being 1.0, because that
 * is what a meter is given and decibels are a view of it.
 */

/**
 * THE SURFACE an adapter presents, and the only way the rest of the module
 * reaches it.
 *
 * It is constructed as `new Source(options, handlers)`. `options` is the
 * connection form, read on every start rather than copied out of, so that a
 * changed address is picked up by stopping and starting again. `handlers`
 * carries three: `onStatus(state, message)`, where state is 'connected',
 * 'connecting' or anything else for a failure and message is what to show and
 * log; `onChanged()`, which says that the list or a fact in it moved and
 * whatever was built from it needs building again; and `onLog(level, text)`,
 * since an adapter has no log of its own.
 *
 *   start()              open and begin.
 *   stop()               close and drop every timer. Always paired with a later
 *                        start() when the address changes.
 *   watchLevels(wanted)  ask for the level feed, or stop asking. Called the
 *                        moment a button wants a meter and again a while after
 *                        the last one goes, from a path that runs far more often
 *                        than it changes, so asking for a state already in force
 *                        must cost nothing.
 *   list()               [{ id, name }]: the mix first, then the sources by
 *                        name, each name already falling back to the id for a
 *                        source the machine named with nothing. AN EMPTY ARRAY
 *                        when there are no sources, never a list holding the mix
 *                        alone. Both sourceChoices() and presetDefinitions()
 *                        branch on that: one offers "no inputs found" where the
 *                        list is bare and the other offers a single blank preset,
 *                        and a lone mix entry would defeat both.
 *   get(id)              one source's facts, or undefined where the id is not
 *                        one of ours, which is what draws a button as misset:
 *                        { name, channels, muted, volume, reaches, filters,
 *                        reporting }. `reaches` is false only where the source
 *                        is known to miss what the stream sends.
 *   readings(id)         that source's channels as they stand, or null.
 *   mixMembers()         [{ id, readings }], or null.
 *   capabilities         the record below.
 *
 * THE MIX IS IN list() AND IS NOT ANSWERED FOR by get() or readings(). It is not
 * one of the machine's sources and no read of them can speak for it, so it is
 * reached through mixMembers() alone and the drawing sums the members itself.
 *
 * readings(id) RETURNS NULL where the source is not reporting, and that null is
 * a state of its own rather than an absence of news: the source is not live,
 * which is drawn as a hatched bar, where a reading of silence is drawn as a
 * meter at rest. Each entry it does return carries the three readings above and
 * three more worked out by the adapter, because all three move by elapsed time
 * and the frames arrive more often than the buttons are painted:
 * `smoothedLoudness`, `fallingPeak` for the post-fader bar and
 * `fallingInputPeak` for the pre-fader one.
 *
 * mixMembers() RETURNS NULL WHEN NOTHING IS ARRIVING AT ALL AND AN EMPTY ARRAY
 * WHEN THE MACHINE IS RUNNING AND SILENT. The two are drawn differently, as no
 * reading against a live reading of nothing, and nothing else on this surface
 * carries that distinction.
 */

// The one entry in the list that is not one of the machine's own sources: the
// sound leaving it. It belongs to the contract rather than to any adapter,
// because every source has something that goes out, however it is arrived at.
//
// The value is what a saved button holds as its chosen source, so changing it
// would point every mix button in the field at nothing.
const MIX_ID = 'program-mix'
const MIX_NAME = 'PGM-MIX'

// How well an adapter answers for one of the seven things above. Four words
// rather than yes and no, because a reading may be worked out rather than
// measured and the difference is worth keeping: a second machine may well have
// to arrive at its pre-fader level by arithmetic.
//
//   MEASURED  the machine reports it, and what is shown is what it said.
//   DERIVED   worked out here from something else the machine does report, so it
//             follows the truth without being it.
//   ASSUMED   read where the request succeeds and filled in with a default where
//             it fails, which means a value that may never have been measured and
//             cannot be told apart from one that was.
//   NONE      not available at all, so whatever it decides on the button must not
//             be drawn.
const Answers = {
	MEASURED: 'measured',
	DERIVED: 'derived',
	ASSUMED: 'assumed',
	NONE: 'none',
}

/**
 * The shape of a capability record, one key per thing the contract names.
 *
 *   pre      the reading before the fader as well as after it. Without it a
 *            button draws one bar and the incoming side of the form has nothing
 *            to offer.
 *   muted    whether a source is muted.
 *   fader    where its fader stands.
 *   routing  whether it can be known that a source misses what the stream
 *            sends. Without it the off-track warning cannot be given, and a
 *            button must not flash on a guess.
 *   live     whether a source is being mixed at this moment, as against being
 *            quiet.
 *   mix      what the mix entry is worth: MEASURED where the machine meters its
 *            own output, DERIVED where it is summed from the members, NONE where
 *            there is no mix to show.
 *   filters  whether the filters of a source can be read, which decides whether
 *            the light under the fader means anything.
 *
 * Nothing reads this record yet: it is the record a second adapter fills in, and
 * the drawing cannot usefully branch on it until there is one to branch for.
 */

// What a single channel is doing, and how it is worked out.
//
// Only two of these are the ordinary case. The rest are the reason the module
// exists: each of them looks like silence on a plain meter, and each needs a
// different thing done about it.

const State = {
	NO_CONNECTION: 'no-connection',
	NOT_LIVE: 'not-live',
	NO_SIGNAL: 'no-signal',
	MUTED: 'muted',
	FADER_DOWN: 'fader-down',
	NORMAL: 'normal',
	CLIPPING: 'clipping',
}

// Full scale is 1.0. Anything at or above this is breaking up.
const CLIP_LEVEL = 0.99

// Below this a fader counts as down rather than merely quiet. It is about
// -60 dB, far below anything anyone mixes at on purpose.
const FADER_FLOOR = 0.001

// Below this a reading counts as nothing arriving at all, about -80 dB.
const SILENCE = 0.0001

/**
 * Decide what one channel of one source is doing.
 *
 * `channel` is one channel's reading, or null when the source is not reporting
 * at all.
 */
function classify({ connected, channel, muted, volume, clipping }) {
	if (!connected) return State.NO_CONNECTION
	if (!channel) return State.NOT_LIVE

	const arriving = channel.pre > SILENCE
	const leaving = channel.post > SILENCE

	if (!arriving && !leaving) return State.NO_SIGNAL
	if (!leaving) return muted ? State.MUTED : volume <= FADER_FLOOR ? State.FADER_DOWN : State.NO_SIGNAL

	if (clipping) return State.CLIPPING
	return State.NORMAL
}

module.exports = { State, CLIP_LEVEL, classify, Answers, MIX_ID, MIX_NAME }
