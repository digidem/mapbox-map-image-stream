var PNGEncoder = require('png-stream/encoder')
var pumpify = require('pumpify')
var mosaic = require('mosaic-image-stream')
var through = require('through2')

var fitBounds = require('viewport-mercator-project').fitBounds
var getDistanceScales = require('viewport-mercator-project').getDistanceScales
var WebMercatorViewport = require('viewport-mercator-project').default
var mapImageStream = require('./map_image_stream')

var DEFAULTS = {
  style: 'mapbox://styles/mapbox/outdoors-v10',
  bbox: [-7.262, 57.7104, -6.0122, 58.5347],
  width: 1200,
  height: 1600,
  pixelRatio: 2
}

module.exports = mapMosaicStream

function mapMosaicStream (opts) {
  opts = Object.assign({}, DEFAULTS, opts)
  if (!opts.token) {
    throw new Error('you must pass a valid Mapbox public token: https://www.mapbox.com/studio/account/tokens/')
  }
  if (!isValidBbox(opts.bbox)) {
    throw new Error('invalid bbox, it should be an array [west, south, east, west]')
  }
  if (!(opts.width > 0 && opts.height > 0)) {
    throw new Error('width and height must be > 0')
  }
  var dpr = opts.pixelRatio
  if (!(Math.floor(dpr) === dpr && dpr > 0 && dpr <= 4)) {
    throw new Error('opts.pixelRatio must be an integer between 1 and 4 (inclusive)')
  }

  window.devicePixelRatio = dpr
  // Adjust width and height to exact be exact multiple of pixel ratio
  const width = opts.width - (opts.width % dpr) + dpr
  const height = opts.height - (opts.height % dpr) + dpr
  // Dimensions in display pixels
  var dpWidth = width / dpr
  var dpHeight = height / dpr

  var mapViewport = fitViewportToBbox(dpWidth, dpHeight, opts.bbox)
  var tileViewports = getTileViewports(mapViewport, getMaxTileSize(dpr))
  var tileStreams = tileViewports.map(function (rows) {
    var row = 0
    return function (cb) {
      if (row >= rows.length) return cb(null, null)
      var viewport = rows[row++]
      return cb(null, mapImageStream(opts.style, viewport, { token: opts.token }))
    }
  })

  var mosaicStream = mosaic(tileStreams, height)

  var pngStream = new PNGEncoder({
    width: width,
    height: height,
    colorSpace: 'rgba'
  })
  var size = width * height * 4
  var out = pumpify(mosaicStream, progress(onProgress), pngStream)

  pngStream.on('format', function (pngFormat) {
    var metadata = Object.assign({}, pngFormat, {
      zoom: mapViewport.zoom,
      bbox: getViewportBbox(mapViewport),
      metersPerPixel: getDistanceScales(mapViewport).metersPerPixel
    })
    out.emit('format', pngFormat)
    out.emit('metadata', metadata)
  })

  function onProgress (complete) {
    out.emit('progress', complete / size)
  }

  return out
}

// Returns a 2-D array of viewports for tiles of maxTileSize that can
// be mosaiced into the final map image
function getTileViewports (viewport, maxTileSize) {
  var wmv = new WebMercatorViewport(viewport)
  var cols = Math.ceil(viewport.width / maxTileSize)
  var rows = Math.ceil(viewport.height / maxTileSize)

  return Array(cols).fill(null).map(function (_, col) {
    return Array(rows).fill(null).map(function (_, row) {
      var top = row * maxTileSize
      var left = col * maxTileSize
      var right = Math.min(viewport.width, left + maxTileSize)
      var bottom = Math.min(viewport.height, top + maxTileSize)
      var nw = wmv.unproject([left, top])
      var se = wmv.unproject([right, bottom])
      var tileWidth = right - left
      var tileHeight = bottom - top
      var bbox = [nw[0], se[1], se[0], nw[1]]
      const vp = fitViewportToBbox(tileWidth, tileHeight, bbox)
      vp.bbox = bbox
      vp.pixelBounds = [top, right, bottom, left]
      return vp
    })
  })
}

// A through stream that calls a function with the completed size on every
// chunk. It pauses every 500ms to allow a re-render
function progress (onProgress) {
  var lastTick = Date.now()
  var complete = 0
  return through(onChunk)

  function onChunk (chunk, enc, next) {
    complete += chunk.length
    onProgress(complete)
    this.push(chunk)
    // To allow any UI to update we wait until the next animation frame every 500ms
    if (Date.now() - lastTick < 500) return next()
    lastTick = Date.now()
    window.requestAnimationFrame(() => next())
  }
}

// For a given viewport, return the bounding box
function getViewportBbox (viewport) {
  var wmv = new WebMercatorViewport(viewport)
  var nw = wmv.unproject([0, 0])
  var se = wmv.unproject([viewport.width, viewport.height])
  return [nw[0], se[1], se[0], nw[1]]
}

function isValidBbox (b) {
  return Array.isArray(b) &&
    b.length === 4 &&
    b[0] < b[2] &&
    b[1] < b[3] &&
    b[0] >= -180 &&
    b[2] <= 180 &&
    b[1] >= -90 &&
    b[3] <= 90
}

function getMaxTileSize (pixelRatio) {
  var gl = document.createElement('canvas').getContext('webgl')
  if (!gl) throw new Error('webgl not supported in this browser')
  return Math.floor(
    Math.min(4000, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) / pixelRatio
  )
}

// fitBounds with bbox vs. bounds, and with width and height
function fitViewportToBbox (width, height, bbox) {
  var mapZoomCenter = fitBounds({
    width: width,
    height: height,
    bounds: bboxToBounds(bbox)
  })
  return Object.assign({}, mapZoomCenter, {
    width: width,
    height: height
  })
}

function bboxToBounds (bbox) {
  return [[bbox[0], bbox[1]], [bbox[2], bbox[3]]]
}
