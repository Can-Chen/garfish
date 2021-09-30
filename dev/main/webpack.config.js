const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  devtool: 'source-map',

  mode: process.env.TEST_ENV ? 'production' : 'development',

  entry: {
    main: './src/index.ts',
  },

  output: {
    filename: '[name].js',
    path: path.join(__dirname, 'dist'),
  },

  devServer: {
    open: true,
    port: '2333',
    compress: true,
    historyApiFallback: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
    client: {
      logging: 'warn',
      overlay: {
        errors: true,
        warnings: false,
      },
    },
  },

  resolve: {
    extensions: ['.js', '.mjs', '.jsx', '.ts', '.tsx'],
  },

  module: {
    rules: [
      {
        test: /\.ts(x)?$/,
        exclude: /node_modules/,
        use: { loader: 'ts-loader' },
      },
      {
        type: 'javascript/auto',
        test: /\.mjs$/,
        use: [],
      },
      {
        test: /\.(le|c)ss$/,
        use: ['style-loader', 'css-loader', 'less-loader'],
      },
    ],
  },

  plugins: [
    new HtmlWebpackPlugin({
      inject: true,
      template: './index.html',
    }),
  ],
};
