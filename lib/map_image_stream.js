var createFBO = require('gl-fbo')
var createGlPixelStream = require('gl-pixel-stream')
var pumpify = require('pumpify')

var limit = require('./limit_stream')
var mapboxgl = require('mapbox-gl')

module.exports = mapImageStream

/**
 * Returns a stream of raw image data from a specific map area
 * @param {object} viewport An object defining the viewport of the map
 * @param {number} viewport.width Width of map in device pixels
 * @param {number} viewport.height Height of map in device pixels
 * @param {number} viewport.zoom Zoom of map
 * @param {number} viewport.longitude Longitude of center of map
 * @param {number} viewport.latitude Latitude of center of map
 * @param {object} opts Options object
 * @param {string} opts.token Mapbox access token
 */
function mapImageStream (style, viewport, opts) {
  mapboxgl.accessToken = opts.token
  var mapDiv = document.createElement('div')
  mapDiv.style.position = 'absolute'
  mapDiv.style.visibility = 'hidden'
  mapDiv.style.width = viewport.width + 'px'
  mapDiv.style.height = viewport.height + 'px'
  document.body.appendChild(mapDiv)

  var map = window.map = new mapboxgl.Map({
    style: style,
    container: mapDiv,
    center: [viewport.longitude, viewport.latitude],
    zoom: viewport.zoom,
    bearing: 0,
    pitch: 0,
    preserveDrawingBuffer: true
  })

  var gl = map.painter.context.gl
  // Dimensions in absolute pixels (vs. display pixels)
  var pixelDim = [viewport.width, viewport.height].map(function (d) {
    return d * window.devicePixelRatio
  })

  var stream = pumpify()

  var fbo = createFBO(gl, pixelDim, { stencil: true })
  fbo.bind()

  onRenderComplete(map, streamCanvas)

  return stream

  function streamCanvas () {
    var glStream = createGlPixelStream(gl, fbo.handle, fbo.shape, { flipY: true })
    glStream.on('end', () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      fbo.dispose()
      map.remove()
      mapDiv.remove()
    })
    var format = stream.format = {
      width: pixelDim[0],
      height: pixelDim[1],
      colorSpace: 'rgba'
    }
    stream.emit('format', format)
    stream.setPipeline(glStream, limit(format))
  }
}

// Call a function when the map has finished loading and everything is rendered
// A bit hacky to deal with edge cases when the map had not finished rendering
// even though the 'load' event fired.
// WARNING: on slow internet connections the timeout of 2000ms might not be enough
function onRenderComplete (map, fn) {
  if (map.loaded()) {
    onRender()
  } else {
    map.on('load', onRender)
  }
  var hasCompleted = false
  function onRender () {
    process.nextTick(() => {
      if (map.areTilesLoaded() && map.isStyleLoaded()) {
        var timeout = setTimeout(() => {
          hasCompleted = true
          fn()
        }, 2000)
        map.once('render', () => {
          if (hasCompleted) {
            return console.error('a map tile emitted a render' +
              'event after we saved the PNG image. This might be because your' +
              'internet connection is very slow, and it means that some icons' +
              'may be missing from the map')
          }
          clearTimeout(timeout)
          onRender()
        })
      } else {
        map.once('render', onRender)
      }
    })
  }
}
